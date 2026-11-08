/**
 * The emitter config `emitLogicAppsJson` consumes, resolved from a parsed
 * flowforger.config.json.
 *
 * The file keeps `connections` at the top of its `global` section and the
 * emitter switches (`includeMetadata`, `includeAuthentication`) under
 * `global.emitter` — the shape `flowforger init` writes — but the emitter reads
 * both from the top level of one object. This surfaces the `emitter` keys
 * there, keeps a top-level `includeMetadata` of an older config working, and
 * applies the `environments.<name>` overlay the way it always has: a shallow
 * merge over the global section, except that the two `emitter` blocks are
 * merged per key.
 */
export function resolveEmitterConfig(raw: any, environment?: string): Record<string, any> {
  if (!raw || typeof raw !== 'object') return {};
  const section: Record<string, any> = raw.global && typeof raw.global === 'object' ? raw.global : raw;
  const overlay: Record<string, any> =
    (environment && raw.environments && typeof raw.environments[environment] === 'object' && raw.environments[environment]) || {};

  const { emitter: globalEmitter, ...globalRest } = section;
  const { emitter: envEmitter, ...envRest } = overlay;
  const merged: Record<string, any> = { ...globalRest, ...envRest };
  const emitter: Record<string, any> = { ...(globalEmitter || {}), ...(envEmitter || {}) };

  const result: Record<string, any> = { ...merged, ...emitter };
  if (merged.connections && emitter.connections) {
    result.connections = { ...merged.connections, ...emitter.connections };
  }
  return result;
}
