/**
 * A thin client for the Power Automate Flow API (api.flow.microsoft.com,
 * `Microsoft.ProcessSimple`): environments, a flow's runs, a run's actions and
 * their repetitions. Used by `flowforger runs` / `run-show`. The token is a
 * flow-service token (`acquireFlowServiceToken` in auth.ts, or `--flow-token`).
 * `fetchImpl` is injectable so the client can be tested without a network.
 */

export interface FlowApiOptions {
  token: string;
  /** Default https://api.flow.microsoft.com */
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

export class FlowApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) {
    super(message);
    this.name = 'FlowApiError';
  }
}

export interface FlowEnvironment {
  id: string;
  displayName?: string;
  /** The linked Dataverse instance URL, when the environment has one. */
  instanceUrl?: string;
  isDefault?: boolean;
}

export interface CloudRunSummary {
  runId: string;
  status: string;
  startTime?: string;
  endTime?: string;
  trigger?: string;
  error?: unknown;
}

import type { CloudActionRecord, CloudRepetition } from '@flowforger/cloud-run';
export type { CloudActionRecord, CloudRepetition };

const API_VERSION = '2016-11-01';

export class FlowApiClient {
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: FlowApiOptions) {
    this.apiBase = (opts.apiBase ?? 'https://api.flow.microsoft.com').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private url(path: string): string {
    return `${this.apiBase}/providers/Microsoft.ProcessSimple/${path}${path.includes('?') ? '&' : '?'}api-version=${API_VERSION}`;
  }

  /** GET an absolute URL (a nextLink) or a path under Microsoft.ProcessSimple. */
  private async get(pathOrUrl: string): Promise<any> {
    const url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : this.url(pathOrUrl);
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.opts.token}`, Accept: 'application/json' },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new FlowApiError(`Flow API ${res.status} ${res.statusText} for ${url.split('?')[0]}: ${text.slice(0, 300)}`, res.status, text);
    }
    return text ? JSON.parse(text) : undefined;
  }

  /** Every page of a `{ value, nextLink }` listing. */
  private async getAll(path: string): Promise<any[]> {
    const out: any[] = [];
    let next: string | undefined = path;
    while (next) {
      const data = await this.get(next);
      out.push(...(data?.value ?? []));
      next = data?.nextLink;
    }
    return out;
  }

  /**
   * The content behind an inputsLink/outputsLink. The URI is pre-signed, so no
   * Authorization header; binary content comes back as `{ $content-type, $content }`,
   * an empty body as null (the way the conformance harness reads it).
   */
  async fetchLink(link: { uri?: string } | undefined): Promise<unknown> {
    if (!link?.uri) return undefined;
    const res = await this.fetchImpl(link.uri, { headers: { Accept: 'application/json' } });
    const type = res.headers.get('content-type') ?? '';
    if (type && !/^application\/json\b/i.test(type)) {
      const bytes = Buffer.from(await res.arrayBuffer());
      return { '$content-type': type, $content: bytes.toString('base64') };
    }
    const text = await res.text();
    if (text === '') return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async listEnvironments(): Promise<FlowEnvironment[]> {
    const items = await this.getAll('environments');
    return items.map((e: any) => ({
      id: e.name,
      displayName: e.properties?.displayName,
      instanceUrl: e.properties?.linkedEnvironmentMetadata?.instanceUrl,
      isDefault: e.properties?.isDefault,
    }));
  }

  async listRuns(environmentId: string, flowId: string, opts: { top?: number; status?: string } = {}): Promise<CloudRunSummary[]> {
    let path = `environments/${environmentId}/flows/${flowId}/runs?$top=${opts.top ?? 20}`;
    if (opts.status) path += `&$filter=status eq '${opts.status}'`;
    const data = await this.get(path);
    return (data?.value ?? []).map((r: any) => ({
      runId: r.name,
      status: r.properties?.status,
      startTime: r.properties?.startTime,
      endTime: r.properties?.endTime,
      trigger: r.properties?.trigger?.name,
      ...(r.properties?.error ? { error: r.properties.error } : {}),
    }));
  }

  /** The run record with its trigger expanded (status, times, error, trigger links). */
  async getRun(environmentId: string, flowId: string, runId: string): Promise<any> {
    return this.get(`environments/${environmentId}/flows/${flowId}/runs/${runId}?$expand=properties/trigger`);
  }

  private async record(p: any): Promise<CloudActionRecord> {
    const rec: CloudActionRecord = { status: p?.status ?? 'Unknown' };
    if (p?.code !== undefined) rec.code = p.code;
    if (p?.error !== undefined) rec.error = p.error;
    if (p?.startTime !== undefined) rec.startTime = p.startTime;
    if (p?.endTime !== undefined) rec.endTime = p.endTime;
    if (p?.repetitionCount !== undefined) rec.repetitionCount = p.repetitionCount;
    const inputs = await this.fetchLink(p?.inputsLink);
    if (inputs !== undefined) rec.inputs = inputs;
    const outputs = await this.fetchLink(p?.outputsLink);
    if (outputs !== undefined) rec.outputs = outputs;
    return rec;
  }

  /** Every action of a run by name (an action inside a loop reports its last repetition here). */
  async listRunActions(environmentId: string, flowId: string, runId: string): Promise<Record<string, CloudActionRecord>> {
    const out: Record<string, CloudActionRecord> = {};
    for (const a of await this.getAll(`environments/${environmentId}/flows/${flowId}/runs/${runId}/actions`)) {
      out[a.name] = await this.record(a.properties);
    }
    return out;
  }

  /** Every repetition of an action inside a loop, with the enclosing loops' item indexes. */
  async listRepetitions(environmentId: string, flowId: string, runId: string, actionName: string): Promise<CloudRepetition[]> {
    const out: CloudRepetition[] = [];
    for (const r of await this.getAll(`environments/${environmentId}/flows/${flowId}/runs/${runId}/actions/${encodeURIComponent(actionName)}/repetitions`)) {
      const p = r.properties ?? {};
      out.push({
        ...(await this.record(p)),
        indexes: (p.repetitionIndexes ?? []).map((i: any) => ({ scopeName: i.scopeName, itemIndex: i.itemIndex })),
      });
    }
    return out;
  }
}

/** The environment whose linked Dataverse instance is `dataverseUrl` (host compared case-insensitively). */
export function findEnvironmentForDataverse(envs: FlowEnvironment[], dataverseUrl: string): FlowEnvironment | undefined {
  const host = (u: string | undefined) => {
    if (!u) return undefined;
    try {
      return new URL(u).host.toLowerCase();
    } catch {
      return u.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
    }
  };
  const wanted = host(dataverseUrl);
  if (!wanted) return undefined;
  return envs.find((e) => host(e.instanceUrl) === wanted);
}
