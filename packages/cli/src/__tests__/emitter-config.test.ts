import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { transformCode } from '@flowforger/dsl-native';
import { emitLogicAppsJson } from '@flowforger/emitter-logicapps';
import { resolveEmitterConfig } from '../emitter-config.js';
import { generateConfig } from '../init.js';

const SP = { referenceName: 'shared_sharepointonline', apiId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline' };
const DV = { referenceName: 'shared_commondataserviceforapps', apiId: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps' };

describe('resolveEmitterConfig', () => {
  it('surfaces global.emitter.* next to the connections (the shape init writes)', () => {
    const cfg = resolveEmitterConfig({
      global: {
        parser: { skipMetadataFields: ['operationMetadataId'] },
        emitter: { includeMetadata: false },
        connections: { sharepoint: SP },
      },
    });
    assert.equal(cfg.includeMetadata, false);
    assert.deepEqual(cfg.connections, { sharepoint: SP });
    assert.equal('emitter' in cfg, false, 'the emitter sub-object itself is not passed on');
  });

  it('keeps a top-level includeMetadata/includeAuthentication working (older configs)', () => {
    const cfg = resolveEmitterConfig({ global: { includeMetadata: false, includeAuthentication: false, connections: { sharepoint: SP } } });
    assert.equal(cfg.includeMetadata, false);
    assert.equal(cfg.includeAuthentication, false);
  });

  it('emitter.* wins over a top-level key of the same name', () => {
    const cfg = resolveEmitterConfig({ global: { includeMetadata: true, emitter: { includeMetadata: false } } });
    assert.equal(cfg.includeMetadata, false);
  });

  it('merges the environment overlay: emitter keys per key, the rest shallow', () => {
    const raw = {
      global: { emitter: { includeMetadata: false, includeAuthentication: true }, connections: { sharepoint: SP } },
      environments: {
        dev: { emitter: { includeAuthentication: false }, connections: { dataverse: DV } },
        prod: {},
      },
    };
    const dev = resolveEmitterConfig(raw, 'dev');
    assert.equal(dev.includeMetadata, false, 'the global emitter key survives the overlay');
    assert.equal(dev.includeAuthentication, false, 'the env emitter key wins');
    assert.deepEqual(dev.connections, { dataverse: DV }, 'connections stay a shallow replacement, as before');

    const prod = resolveEmitterConfig(raw, 'prod');
    assert.equal(prod.includeAuthentication, true);
    assert.deepEqual(prod.connections, { sharepoint: SP });

    const none = resolveEmitterConfig(raw);
    assert.deepEqual(none.connections, { sharepoint: SP });
    assert.equal(none.includeMetadata, false);
  });

  it('an unknown environment name falls back to the global section', () => {
    const cfg = resolveEmitterConfig({ global: { emitter: { includeMetadata: false } }, environments: { dev: {} } }, 'qa');
    assert.equal(cfg.includeMetadata, false);
  });

  it('a file without a global section is read as the section itself', () => {
    const cfg = resolveEmitterConfig({ emitter: { includeMetadata: false }, connections: { sharepoint: SP } });
    assert.equal(cfg.includeMetadata, false);
    assert.deepEqual(cfg.connections, { sharepoint: SP });
  });

  it('emitter.connections merge over the section connections', () => {
    const cfg = resolveEmitterConfig({ global: { connections: { sharepoint: SP }, emitter: { connections: { dataverse: DV } } } });
    assert.deepEqual(cfg.connections, { sharepoint: SP, dataverse: DV });
  });

  it('tolerates an empty or non-object file', () => {
    assert.deepEqual(resolveEmitterConfig(undefined), {});
    assert.deepEqual(resolveEmitterConfig(null), {});
    assert.deepEqual(resolveEmitterConfig({}), {});
  });
});

describe('the config init writes reaches the emitter', () => {
  const ir = transformCode(`
@Flow('Cfg Demo')
class CfgDemo {
  @HttpTrigger({ method: 'POST' })
  trigger() {}

  @Action()
  async run(ctx: FlowContext) {
    await ctx.compose('Hello', 'world');
  }
}`);
  const metadataIds = (def: any): string[] => {
    const found: string[] = [];
    JSON.stringify(def, (key, value) => {
      if (key === 'operationMetadataId') found.push(String(value));
      return value;
    });
    return found;
  };

  it('global.emitter.includeMetadata: false suppresses operationMetadataId', () => {
    const file = generateConfig({ clientId: 'c', tenantId: 't', dataverseUrl: 'https://org.crm.dynamics.com', connectionRefs: new Map() });
    assert.equal(file.global.emitter.includeMetadata, false, 'init still writes the flag');
    assert.ok(metadataIds(emitLogicAppsJson(ir)).length > 0, 'the emitter generates ids by default');
    assert.deepEqual(metadataIds(emitLogicAppsJson(ir, resolveEmitterConfig(file))), []);
  });
});
