import type { EnvironmentVariableDefinition, EnvironmentVariableValue } from './env-vars.js';

export * from './env-vars.js';

export interface DataverseClientOptions {
  baseUrl: string; // e.g., https://org.crm.dynamics.com
  token: string; // Bearer token
}

export interface ConnectionReferenceRecord {
  connectionreferenceid: string;
  connectionreferencelogicalname: string;
  connectionreferencedisplayname?: string;
  connectorid: string;
  statecode: number;
}

export class DataverseClient {
  private baseApi: string;
  private token: string;
  constructor(opts: DataverseClientOptions) {
    this.baseApi = `${opts.baseUrl.replace(/\/$/, '')}/api/data/v9.2`;
    this.token = opts.token;
  }

  /**
   * Perform a Dataverse request and return the raw Response.
   * Callers that need response headers (e.g. `OData-EntityId` after a create)
   * use this; everything else goes through `request`.
   */
  private async rawRequest(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${this.baseApi}${path}`, {
      ...init,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json; charset=utf-8',
        'OData-MaxVersion': '4.0',
        'OData-Version': '4.0',
        ...(init.headers || {}),
      } as any,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Dataverse ${res.status}: ${text}`);
    }
    return res;
  }

  private async request(path: string, init: RequestInit = {}) {
    const res = await this.rawRequest(path, init);
    if (res.status === 204) return null;
    return res.json();
  }

  async listSolutionFlows() {
    const select = '$select=workflowid,name,category,statecode,clientdata';
    const filter = '$filter=category eq 5'; // modern cloud flows
    return this.request(`/workflows?${select}&${filter}`);
  }

  async getFlow(workflowId: string) {
    const select = '$select=workflowid,name,description,category,statecode,clientdata';
    return this.request(`/workflows(${workflowId})?${select}`);
  }

  async getFlowByName(name: string) {
    const { match } = await this.findFlowByName(name);
    return match;
  }

  /**
   * Look up a flow by name, and report whether more than one flow shares that
   * name. Dataverse permits duplicate flow names — a plain "first match" lookup
   * (as `getFlowByName` does for `pull`) can silently pick the wrong one, which
   * is unrecoverable once `push` PATCHes over it. Callers doing anything
   * destructive (like `push`) should check `ambiguous` and refuse rather than
   * guess.
   *
   * Fetches `$top=2` — enough to detect a duplicate without paging through the
   * whole environment.
   */
  async findFlowByName(
    name: string,
  ): Promise<{ match: { workflowid: string; name: string; description?: string; category: number; statecode: number; clientdata: string } | null; ambiguous: boolean }> {
    const select = '$select=workflowid,name,description,category,statecode,clientdata';
    const encodedName = encodeURIComponent(name.replace(/'/g, "''"));
    const filter = `$filter=category eq 5 and name eq '${encodedName}'`;
    const result = await this.request(`/workflows?${select}&${filter}&$top=2`);
    const values = result?.value || [];
    return { match: values[0] || null, ambiguous: values.length > 1 };
  }

  async patchFlow(workflowId: string, payload: Partial<{ clientdata: string; statecode: number; statuscode: number }>) {
    return this.request(`/workflows(${workflowId})`, {
      method: 'PATCH',
      headers: { 'If-Match': '*' },
      body: JSON.stringify(payload),
    });
  }

  /**
   * Create a new modern cloud flow (category 5) in Draft state.
   *
   * Dataverse returns 204 with the new record's URI in the `OData-EntityId`
   * header rather than a body, so this reads the GUID from there — which works
   * regardless of `Prefer: return=representation` support.
   *
   * Pass `solutionUniqueName` to create the flow inside a specific solution;
   * otherwise it lands in the environment's default solution.
   */
  async createFlow(
    payload: { name: string; clientdata: string; description?: string },
    opts: { solutionUniqueName?: string } = {},
  ): Promise<{ workflowid: string }> {
    const body: Record<string, unknown> = {
      name: payload.name,
      category: 5,       // modern cloud flow
      type: 1,           // definition (not a template or activation)
      primaryentity: 'none', // required by the platform for modern flows
      clientdata: payload.clientdata,
      statecode: 0,      // Draft — never auto-activate
    };
    if (payload.description) body.description = payload.description;

    const headers: Record<string, string> = {};
    if (opts.solutionUniqueName) {
      headers['MSCRM.SolutionUniqueName'] = opts.solutionUniqueName;
    }

    const res = await this.rawRequest('/workflows', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const entityId = res.headers.get('OData-EntityId') || '';
    const match = /workflows\(([0-9a-fA-F-]{36})\)/.exec(entityId);
    if (!match) {
      throw new Error(
        `Dataverse created the flow but returned no workflow id (OData-EntityId: '${entityId}')`
      );
    }
    return { workflowid: match[1] };
  }

  /**
   * List all modern cloud flows (category 5) in the environment.
   * Returns workflowid, name, description, statecode, and clientdata.
   */
  async listAllFlows() {
    const select = '$select=workflowid,name,description,category,statecode,clientdata';
    const filter = '$filter=category eq 5';
    const result = await this.request(`/workflows?${select}&${filter}&$orderby=name asc`);
    return result?.value || [];
  }

  /**
   * Get a solution by its unique name. Returns null if not found.
   */
  async getSolutionByUniqueName(uniqueName: string) {
    const encodedUniqueName = encodeURIComponent(uniqueName.replace(/'/g, "''"));
    const filter = `$filter=uniquename eq '${encodedUniqueName}'`;
    const result = await this.request(`/solutions?${filter}&$select=solutionid,uniquename,friendlyname&$top=1`);
    return result?.value?.[0] || null;
  }

  /**
   * List workflow IDs (component type 29) in a solution, then fetch their full records.
   */
  async listFlowsInSolution(solutionId: string) {
    // Step 1: get workflow component IDs from solution
    const components = await this.request(
      `/solutioncomponents?$filter=_solutionid_value eq ${solutionId} and componenttype eq 29&$select=objectid`
    );
    const ids: string[] = (components?.value || []).map((c: any) => c.objectid);
    if (ids.length === 0) return [];

    // Step 2: fetch workflows by IDs (batch in groups to avoid URL length limits)
    const batchSize = 50;
    const allFlows: any[] = [];
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      const filterConditions = batch.map(id => `workflowid eq ${id}`).join(' or ');
      const select = '$select=workflowid,name,description,category,statecode,clientdata';
      const result = await this.request(`/workflows?${select}&$filter=(${filterConditions})&$orderby=name asc`);
      allFlows.push(...(result?.value || []));
    }
    return allFlows;
  }

  /** List environment variable definitions (schema name, type, current default). */
  async listEnvironmentVariableDefinitions(): Promise<EnvironmentVariableDefinition[]> {
    const select =
      '$select=environmentvariabledefinitionid,schemaname,displayname,type,defaultvalue';
    const result = await this.request(`/environmentvariabledefinitions?${select}`);
    return result?.value || [];
  }

  /** List current environment variable value records. */
  async listEnvironmentVariableValues(): Promise<EnvironmentVariableValue[]> {
    const select =
      '$select=environmentvariablevalueid,schemaname,value,_environmentvariabledefinitionid_value';
    const result = await this.request(`/environmentvariablevalues?${select}`);
    return (result?.value || []).map((v: any) => ({
      environmentvariablevalueid: v.environmentvariablevalueid,
      schemaname: v.schemaname,
      value: v.value,
      environmentvariabledefinitionid: v._environmentvariabledefinitionid_value,
    }));
  }

  async listConnectionReferences(): Promise<ConnectionReferenceRecord[]> {
    const select = '$select=connectionreferenceid,connectionreferencelogicalname,connectionreferencedisplayname,connectorid,statecode';
    const filter = '$filter=statecode eq 0'; // active only
    const result = await this.request(`/connectionreferences?${select}&${filter}&$orderby=connectionreferencedisplayname asc`);
    return result?.value || [];
  }
}

export default DataverseClient;

