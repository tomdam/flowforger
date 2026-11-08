import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { WordOnlineConnector } from "../index.js";
import type { RunContext } from "@flowforger/engine";

const DOCX_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14]);

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = (async () => {
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      text: async () => "",
      json: async () => ({}),
      arrayBuffer: async () => DOCX_BYTES.buffer,
    } as unknown as Response;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A context whose log collects entries, so the normalised inputs can be inspected. */
function makeLoggingCtx(entries: Array<Record<string, unknown>>): RunContext {
  return {
    variables: {},
    actions: new Map(),
    now: () => new Date(),
    sleep: async () => {},
    log: (e: Record<string, unknown>) => entries.push(e),
    secrets: () => undefined,
    connector: () => {
      throw new Error("not needed");
    },
  } as unknown as RunContext;
}

describe("WordOnlineConnector populate aliases", () => {
  // Every name for "Populate a Microsoft Word template" must hand the template
  // fields to the populate step; before, only PopulateWordTemplate/CreateFileItem
  // did and the typed DSL name returned the template unfilled.
  for (const op of ["PopulateWordTemplate", "PopulateAWordTemplate", "CreateFileItem"]) {
    it(`${op} builds templateData from the designer-style fields`, async () => {
      const entries: Array<Record<string, unknown>> = [];
      const connector = new WordOnlineConnector({ token: "t" });
      try {
        await connector.invoke(
          op,
          { source: "me", file: "tpl1", "dynamicFileSchema/123": "Alice", Title: "Report" },
          makeLoggingCtx(entries),
        );
      } catch {
        // The fake bytes are not a real .docx; the populate step may fail after logging.
      }
      const populate = entries.find((e) => e.type === "wordonline.populateTemplate");
      assert.ok(populate, `no populateTemplate log entry: ${JSON.stringify(entries)}`);
      assert.deepEqual(populate!.templateData, { "123": "Alice", Title: "Report" });
    });
  }
});
