import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { WordOnlineConnector } from "../index.js";
import type { RunContext } from "@flowforger/engine";

function makeCtx(): RunContext {
  return {
    variables: {},
    actions: new Map(),
    now: () => new Date(),
    sleep: async () => {},
    log: () => {},
    secrets: () => undefined,
    connector: () => {
      throw new Error("not needed");
    },
  } as unknown as RunContext;
}

const DOCX_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14]); // "PK\x03\x04\x14"
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"

let fetchCalls: string[] = [];
/** URL substring → response. First matching route wins. */
let routes: Array<{
  match: string;
  bytes?: Uint8Array;
  json?: unknown;
  status?: number;
}> = [];

const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls = [];
  routes = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    fetchCalls.push(url);
    const route = routes.find((r) => url.includes(r.match));
    if (!route) throw new Error(`unexpected fetch: ${url}`);
    const status = route.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Map(),
      text: async () =>
        route.json !== undefined ? JSON.stringify(route.json) : "",
      json: async () => route.json,
      arrayBuffer: async () => (route.bytes ?? new Uint8Array()).buffer,
    } as unknown as Response;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("WordOnlineConnector output shape", () => {
  // The cloud connector hands the next action binary content in the Logic Apps envelope,
  // `{ "$content-type": "...", "$content": "<base64>" }` and nothing else. The engine's
  // base64()/string()/dataUri() recognise exactly that shape (isBinaryContent), so a
  // differently-cased key or an extra key makes `base64(body('Populate'))` encode
  // the text "[object Object]" instead of the file.
  it("PopulateWordTemplate returns the cloud binary envelope", async () => {
    routes.push({ match: "/me/drive/items/tpl1/content", bytes: DOCX_BYTES });
    const connector = new WordOnlineConnector({ token: "t" });

    const out = await connector.invoke(
      "PopulateWordTemplate",
      { location: "me", fileId: "tpl1" },
      makeCtx(),
    );

    assert.deepEqual(out, {
      "$content-type":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      $content: Buffer.from(DOCX_BYTES).toString("base64"),
    });
  });

  it("ConvertToPdf returns the cloud binary envelope", async () => {
    routes.push({
      match: "/me/drive/items/doc1/content?format=pdf",
      bytes: PDF_BYTES,
    });
    routes.push({ match: "/me/drive/items/doc1", json: { name: "doc1.docx" } });
    const connector = new WordOnlineConnector({ token: "t" });

    const out = await connector.invoke(
      "ConvertToPdf",
      { location: "me", fileId: "doc1" },
      makeCtx(),
    );

    assert.deepEqual(out, {
      "$content-type": "application/pdf",
      $content: Buffer.from(PDF_BYTES).toString("base64"),
    });
  });
});
