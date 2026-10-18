/**
 * Env var resolution for `flowforger run`: when a Dataverse connection is
 * available (--dv-url/--dv-token or --auth), env-var-backed flow parameters
 * resolve to their CURRENT environment values (value record, else the
 * definition's current default) instead of the design-time defaultValue
 * snapshot baked into the flow. Explicit `--param key=value` flags win over
 * resolved env vars. Resolution failure degrades to the explicit overrides
 * (i.e. the pre-existing behavior) rather than failing the run.
 */
import {
  DataverseClient,
  fetchEnvVarResolution,
  type EnvVarFlowLike,
  type ResolvedEnvVar,
} from '@flowforger/dataverse-sdk';

export interface ResolveRunOverridesOptions {
  ir: EnvVarFlowLike;
  dvUrl?: string;
  dvToken?: string;
  /** Overrides from explicit `--param key=value` flags; these win per key. */
  explicitOverrides?: Record<string, unknown>;
  /** Diagnostics sink (the CLI passes console.error to keep stdout clean). */
  log?: (msg: string) => void;
  /** Print secret-looking values in the log (`--verbose`); by default they are redacted. */
  showSecrets?: boolean;
}

/** Dataverse environment variable type code for a Secret (Azure Key Vault reference). */
const ENV_VAR_TYPE_SECRET = 100000005;
const SECRET_NAME = /key|secret|password|passwd|pwd|token|credential/i;

/**
 * Whether an env var's value must stay out of logs: a Secret-typed definition,
 * or a name that says it holds one (`brk_DocxCleanupFunctionKey`). Agents and
 * CI capture stderr into files and transcripts, so the default errs on redacting.
 */
export function isSecretEnvVar(r: Pick<ResolvedEnvVar, 'schemaName' | 'displayName' | 'type'>): boolean {
  if (r.type === ENV_VAR_TYPE_SECRET) return true;
  return SECRET_NAME.test(r.schemaName) || SECRET_NAME.test(r.displayName ?? '');
}

export async function resolveRunParameterOverrides(
  opts: ResolveRunOverridesOptions
): Promise<Record<string, unknown> | undefined> {
  const { ir, dvUrl, dvToken, explicitOverrides, log = () => {}, showSecrets = false } = opts;
  if (!dvUrl || !dvToken) return explicitOverrides;

  try {
    const client = new DataverseClient({ baseUrl: dvUrl, token: dvToken });
    const resolution = await fetchEnvVarResolution(ir, client);
    if (!resolution) return explicitOverrides;

    for (const r of resolution.resolved) {
      if (r.source === 'unresolved') {
        log(
          `[WARN] Env var '${r.schemaName}' has no value or default in this environment — the flow definition default will be used.`
        );
      } else {
        const source = r.source === 'value' ? 'set value' : 'definition default';
        if (!showSecrets && isSecretEnvVar(r)) {
          log(`[INFO] Env var '${r.schemaName}' = [redacted] (${source}; --verbose shows it)`);
        } else {
          const display = typeof r.value === 'string' ? r.value : JSON.stringify(r.value);
          log(`[INFO] Env var '${r.schemaName}' = ${display} (${source})`);
        }
      }
    }

    // Explicit --param flags spread last, so they win per key.
    return { ...resolution.overrides, ...(explicitOverrides ?? {}) };
  } catch (err) {
    log(
      `[WARN] Could not resolve environment variable values (${err instanceof Error ? err.message : String(err)}); flow definition defaults will be used.`
    );
    return explicitOverrides;
  }
}
