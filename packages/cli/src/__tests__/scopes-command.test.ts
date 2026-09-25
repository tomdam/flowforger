import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  collectAllConnectorScopes,
  resourceKeyForUrl,
  RESOURCE_APIS,
} from "../auth.js";

describe("collectAllConnectorScopes (flowforger scopes --all)", () => {
  it("covers every connector the resolver knows about, mapped to a known API", async () => {
    const all = await collectAllConnectorScopes();
    const connectors = all.map((e) => e.connector);
    for (const c of [
      "office365",
      "office365users",
      "office365groups",
      "teams",
      "wordonline",
      "excelonline",
      "onedrive",
      "sharepoint",
      "dataverse",
    ]) {
      assert.ok(connectors.includes(c), `missing connector ${c}`);
    }
    for (const e of all) {
      assert.ok(
        RESOURCE_APIS[e.resource],
        `unknown resource ${e.resource} for ${e.connector}`,
      );
      assert.ok(e.scopes.length > 0, `${e.connector} has no scopes`);
      assert.deepEqual(
        e.scopes,
        [...e.scopes].sort(),
        `${e.connector} scopes not sorted`,
      );
      assert.equal(
        new Set(e.scopes).size,
        e.scopes.length,
        `${e.connector} has duplicate scopes`,
      );
    }
  });

  it("does not apply subsumption — both the narrow and the broad scope are listed", async () => {
    const all = await collectAllConnectorScopes();
    const graph = new Set(
      all.filter((e) => e.resource === "graph").flatMap((e) => e.scopes),
    );
    // Entra consent is per scope: a read-only flow requests Mail.Read, so the
    // app registration must carry it even though Mail.ReadWrite is also listed.
    assert.ok(graph.has("Mail.Read"));
    assert.ok(graph.has("Mail.ReadWrite"));
  });

  it("lists bare permission names, not resource-prefixed MSAL scopes", async () => {
    const all = await collectAllConnectorScopes();
    for (const e of all)
      for (const s of e.scopes)
        assert.ok(!s.startsWith("http"), `${e.connector}: ${s}`);
  });
});

describe("resourceKeyForUrl", () => {
  const cfg = {
    resources: {
      sharepoint: "https://contoso.sharepoint.com",
      dataverse: "https://org.crm.dynamics.com",
    },
  };
  it("maps configured resources and the fixed Graph/Flow Service URLs", () => {
    assert.equal(
      resourceKeyForUrl("https://graph.microsoft.com", cfg),
      "graph",
    );
    assert.equal(
      resourceKeyForUrl("https://contoso.sharepoint.com", cfg),
      "sharepoint",
    );
    assert.equal(
      resourceKeyForUrl("https://org.crm.dynamics.com", cfg),
      "dataverse",
    );
    assert.equal(
      resourceKeyForUrl("https://service.flow.microsoft.com", cfg),
      "flowservice",
    );
  });
  it("falls back to hostname patterns when nothing is configured", () => {
    assert.equal(
      resourceKeyForUrl("https://x.sharepoint.com", {}),
      "sharepoint",
    );
    assert.equal(
      resourceKeyForUrl("https://x.crm4.dynamics.com", {}),
      "dataverse",
    );
    assert.equal(resourceKeyForUrl("https://example.com", {}), undefined);
  });
});
