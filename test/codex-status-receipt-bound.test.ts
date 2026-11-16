import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { MessageController } from "../src/runtime/codex/messages.ts";
import { CodexConnection } from "../src/runtime/codex/protocol.ts";
import { CodexStore } from "../src/runtime/codex/store.ts";
import { harnessFixture } from "./codex-fixture.test.ts";

test("a status receipt stays deliverable when lane finals exceed the receipt bound", async () => {
  const { f, d } = await harnessFixture();
  const lead = await f.rt.create({ ...f.spec, role: "lead", env: {} });
  d.store.setRole("lead", lead);
  const at = d.now();
  const large = "x".repeat(32768);
  for (const key of ["large", "recent"])
    d.store.saveLane({
      key,
      sessionRef: { runtime: "codex", id: crypto.randomUUID() },
      paneId: "",
      tabId: "",
      brief: "fixture",
      cwd: f.spec.cwd,
      status: "ready",
      createdAt: at,
      lastActivityAt: at,
      nudges: 0,
      log: [],
      final: key === "large" ? { text: large, evidence: [large], at } : { text: "short", evidence: ["e"], at },
    });
  await f.rt.startAgent(lead, { prompt: "Inspect the lanes." });
  const source = f.finish(lead.id, JSON.stringify({ version: 1, kind: "action", tool: "dori_status", arguments: {} }));
  const connection = new CodexConnection(f.env.DORI_CODEX_SOCKET);
  f.cleanup.push(() => connection.disconnect());
  const store = new CodexStore(f.root);

  await new MessageController(d, store, connection).reconcile(lead);

  using db = new Database(`${store.path(lead.id)}.messages.sqlite`, { readonly: true });
  const row = db
    .query<{ state: string; receipt: string; result: string }, [string]>(
      "SELECT state,receipt,result FROM effects WHERE turn=?",
    )
    .get(source.id);
  expect({ state: row?.state, receipt: row?.receipt, lanes: row && JSON.parse(row.result)["result"] }).toEqual({
    state: "completed",
    receipt: "delivered",
    lanes: [
      { key: "large", status: "ready", final: { at, truncated: true } },
      { key: "recent", status: "ready", final: { text: "short", evidence: ["e"], at } },
    ],
  });
});
