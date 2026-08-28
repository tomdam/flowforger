/**
 * Environment variable resolution for local flow runs.
 *
 * When Power Automate saves a flow, each env var reference becomes a flow
 * parameter whose `defaultValue` is a design-time snapshot of the definition's
 * default. The cloud runtime substitutes the real value at run time; a local
 * engine only sees the snapshot. These helpers fetch the environment's
 * current value records (falling back to the definition's CURRENT default)
 * and turn them into engine `parameterOverrides`, so local runs use the same
 * values a cloud run would. Shared by the web app and the CLI.
 */

export interface EnvironmentVariableDefinition {
  environmentvariabledefinitionid: string;
  schemaname: string;
  displayname?: string;
  /** 100000000=String, 100000001=Number, 100000002=Boolean, 100000003=JSON, 100000004=Data Source, 100000005=Secret */
  type?: number;
  defaultvalue?: string;
}

export interface EnvironmentVariableValue {
  environmentvariablevalueid: string;
  schemaname: string;
  value: string;
  environmentvariabledefinitionid: string;
}

/**
 * Structural view of the flow IR — just enough to find env-var-backed
 * parameters, so this package needs no dependency on @flowforger/ir.
 */
export interface EnvVarFlowLike {
  parameters?: Record<
    string,
    { metadata?: { schemaName?: string } } | undefined
  >;
}

export interface EnvVarBinding {
  /** Flow parameter name, e.g. "Site URL (cr123_siteUrl)". */
  parameterName: string;
  /** Dataverse env var definition schema name, e.g. "cr123_siteUrl". */
  schemaName: string;
}

export type EnvVarSource = 'value' | 'default' | 'unresolved';

export interface ResolvedEnvVar {
  parameterName: string;
  schemaName: string;
  /** Definition display name, when the definition was found. */
  displayName?: string;
  /** Coerced runtime value; undefined when unresolved. */
  value?: unknown;
  /**
   * 'value' = a current value record exists; 'default' = definition's current
   * default; 'unresolved' = neither found (the engine keeps the IR snapshot).
   */
  source: EnvVarSource;
}

/** Minimal client surface needed for resolution (testable). */
export interface EnvVarClient {
  listEnvironmentVariableDefinitions(): Promise<EnvironmentVariableDefinition[]>;
  listEnvironmentVariableValues(): Promise<EnvironmentVariableValue[]>;
}

/** Env-var-backed parameters of a flow, i.e. those carrying metadata.schemaName. */
export function collectEnvVarParameters(flow: EnvVarFlowLike): EnvVarBinding[] {
  const out: EnvVarBinding[] = [];
  for (const [parameterName, def] of Object.entries(flow.parameters ?? {})) {
    const schemaName = def?.metadata?.schemaName;
    if (typeof schemaName === 'string' && schemaName.length > 0) {
      out.push({ parameterName, schemaName });
    }
  }
  return out;
}

/**
 * Coerce the stored string to the definition's declared type. Env var values
 * are always persisted as strings; number/boolean/JSON definitions need real
 * values so expressions compare correctly. Unparseable values pass through as
 * the raw string rather than dropping data.
 */
function coerceValue(raw: string, type: number | undefined): unknown {
  switch (type) {
    case 100000001: {
      // Number
      const n = Number(raw);
      return Number.isFinite(n) && raw.trim() !== '' ? n : raw;
    }
    case 100000002: {
      // Boolean — the Power Platform UI writes "yes"/"no", other tooling
      // writes "true"/"false"; accept both plus "1"/"0".
      const v = raw.trim().toLowerCase();
      if (v === 'true' || v === 'yes' || v === '1') return true;
      if (v === 'false' || v === 'no' || v === '0') return false;
      return raw;
    }
    case 100000003: {
      // JSON
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }
    default:
      return raw;
  }
}

/**
 * Resolve each binding against the environment's definitions and value
 * records: value record first, then the definition's current default. An
 * empty/blank value record counts as absent (matching cloud behavior, where a
 * blank value falls back to the default).
 */
export function resolveEnvVarValues(
  bindings: EnvVarBinding[],
  defs: EnvironmentVariableDefinition[],
  values: EnvironmentVariableValue[]
): ResolvedEnvVar[] {
  const defsBySchema = new Map(defs.map((d) => [d.schemaname.toLowerCase(), d]));
  const valuesByDefId = new Map(values.map((v) => [v.environmentvariabledefinitionid, v]));

  return bindings.map(({ parameterName, schemaName }) => {
    const def = defsBySchema.get(schemaName.toLowerCase());
    if (!def) return { parameterName, schemaName, source: 'unresolved' as const };

    const valueRecord = valuesByDefId.get(def.environmentvariabledefinitionid);
    const hasValue = typeof valueRecord?.value === 'string' && valueRecord.value !== '';
    const raw = hasValue ? valueRecord!.value : def.defaultvalue;
    if (typeof raw !== 'string' || raw === '') {
      return { parameterName, schemaName, displayName: def.displayname, source: 'unresolved' as const };
    }
    return {
      parameterName,
      schemaName,
      displayName: def.displayname,
      value: coerceValue(raw, def.type),
      source: hasValue ? ('value' as const) : ('default' as const),
    };
  });
}

/** Engine `parameterOverrides` for everything that resolved. */
export function buildParameterOverrides(resolved: ResolvedEnvVar[]): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  for (const r of resolved) {
    if (r.source !== 'unresolved') overrides[r.parameterName] = r.value;
  }
  return overrides;
}

export interface EnvVarResolution {
  resolved: ResolvedEnvVar[];
  overrides: Record<string, unknown>;
}

/**
 * Fetch + resolve in one step. Returns null — without touching the network —
 * when the flow has no env-var-backed parameters.
 */
export async function fetchEnvVarResolution(
  flow: EnvVarFlowLike,
  client: EnvVarClient
): Promise<EnvVarResolution | null> {
  const bindings = collectEnvVarParameters(flow);
  if (bindings.length === 0) return null;

  const [defs, values] = await Promise.all([
    client.listEnvironmentVariableDefinitions(),
    client.listEnvironmentVariableValues(),
  ]);
  const resolved = resolveEnvVarValues(bindings, defs, values);
  return { resolved, overrides: buildParameterOverrides(resolved) };
}
