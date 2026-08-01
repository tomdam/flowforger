import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildConnectors } from '../connectors.js';

describe('buildConnectors', () => {
  it('always provides http, and nothing else without tokens', () => {
    const c = buildConnectors({});
    assert.ok(c['http'], 'http connector is always present');
    assert.deepEqual(Object.keys(c).sort(), ['http']);
  });

  it('adds sharepoint only when spToken is present', () => {
    assert.equal(buildConnectors({}).sharepoint, undefined);
    assert.ok(buildConnectors({ spToken: 't' }).sharepoint);
  });

  it('adds dataverse only when BOTH dvUrl and dvToken are present', () => {
    assert.equal(buildConnectors({ dvToken: 't' }).dataverse, undefined);
    assert.equal(buildConnectors({ dvUrl: 'https://o.crm.dynamics.com' }).dataverse, undefined);
    assert.ok(buildConnectors({ dvUrl: 'https://o.crm.dynamics.com', dvToken: 't' }).dataverse);
  });

  it('graphToken builds all seven Graph connectors plus webcontents', () => {
    const c = buildConnectors({ graphToken: 'g' });
    for (const key of [
      'office365', 'office365users', 'office365groups', 'teams',
      'wordonlinebusiness', 'excelonlinebusiness', 'onedriveforbusiness', 'webcontents',
    ]) {
      assert.ok(c[key], `expected connector '${key}'`);
    }
  });

  it('registers aliases pointing at the same instance', () => {
    const c = buildConnectors({ graphToken: 'g' });
    assert.equal(c['wordonline'], c['wordonlinebusiness']);
    assert.equal(c['excelonline'], c['excelonlinebusiness']);
    assert.equal(c['onedrive'], c['onedriveforbusiness']);
  });

  it('per-connector token works without a graphToken', () => {
    const c = buildConnectors({ wordToken: 'w' });
    assert.ok(c['wordonlinebusiness'], 'wordToken alone builds Word Online');
    assert.equal(c['office365'], undefined, 'connectors with no override stay absent');
  });

  it('per-connector token overrides graphToken for that connector only', () => {
    const c = buildConnectors({ graphToken: 'g', excelToken: 'e' });
    assert.ok(c['excelonlinebusiness']);
    assert.ok(c['office365']);
  });

  it('every built connector is a usable instance with an invoke method', () => {
    const c = buildConnectors({
      spToken: 'sp', dvUrl: 'https://o.crm.dynamics.com', dvToken: 'dv',
      graphToken: 'g', wordToken: 'w', excelToken: 'e', onedriveToken: 'o',
    });
    const keys = Object.keys(c);
    assert.ok(keys.length >= 12, `expected the full connector set, got ${keys.length}: ${keys}`);
    for (const [name, connector] of Object.entries(c)) {
      assert.equal(typeof (connector as any).invoke, 'function', `${name} must expose invoke()`);
    }
  });

  it('builds webcontents from any token it can actually use', () => {
    assert.ok(buildConnectors({ spToken: 't' }).webcontents, 'SharePoint-only run gets webcontents');
    assert.ok(
      buildConnectors({ dvUrl: 'https://o.crm.dynamics.com', dvToken: 'd' }).webcontents,
      'Dataverse-only run gets webcontents',
    );
    assert.ok(buildConnectors({ graphToken: 'g' }).webcontents, 'graph-only run still gets webcontents');
    assert.equal(buildConnectors({}).webcontents, undefined, 'no tokens -> no webcontents');
    assert.equal(
      buildConnectors({ wordToken: 'w' }).webcontents,
      undefined,
      'wordToken alone gives WebContents no SharePoint or Dataverse token to use',
    );
  });
});
