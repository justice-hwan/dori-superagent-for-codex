import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { callBridgeTool, type BridgeScope } from "../src/runtime/codex/bridge-tools.ts";
import { prepareBridgeDone, readDoneTarget } from "../src/runtime/codex/done-admission.ts";
import { CodexConnection } from "../src/runtime/codex/protocol.ts";
import { CodexStore } from "../src/runtime/codex/store.ts";
import { harnessFixture } from "./codex-fixture.test.ts";

test.each(["inbox", "submit"] as const)(
  "actual separate process %s holder prevents preparation until its explicit release",
  async (resource) => {
    const { f, d } = await harnessFixture();
    const lead = await f.rt.create({ ...f.spec, role: "lead", env: {} });
    const lane = await f.rt.create({ ...f.spec, role: "lane", env: { DORI_LANE: "audit" } });
    d.store.setRole("lead", lead);
    d.store.saveLane({
      key: "audit",
      sessionRef: lane,
      paneId: lane.id,
      tabId: "",
      brief: "actual admitted fixture",
      cwd: f.spec.cwd,
      status: "working",
      createdAt: d.now(),
      lastActivityAt: d.now(),
      nudges: 0,
      log: [],
    });
    const scope: BridgeScope = {
      root: realpathSync(f.root),
      cwd: realpathSync(f.spec.cwd),
      role: "lead",
      key: "",
      id: lead.id,
    };
    await callBridgeTool(d, { ...scope, role: "lane", key: "audit", id: lane.id }, "dori_ready", {
      text: "Actual admission complete.",
      evidence: ["file:///fixture"],
    });
    const store = new CodexStore(f.root);
    const connection = new CodexConnection(f.env.DORI_CODEX_SOCKET);
    f.cleanup.push(() => connection.disconnect());
    const target = readDoneTarget(d, "audit", scope.cwd);
    const path = resource === "inbox" ? `${d.store.inboxPath(lane)}.lock` : `${store.path(lane.id)}.submit-lock`;
    const lockModule = new URL("../src/inbox-lock.ts", import.meta.url).href;
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `import {takeInboxLock} from ${JSON.stringify(lockModule)};
const release = takeInboxLock(${JSON.stringify(path)}, Date.now());
if (!release) throw new Error("No actual holder");
console.log("HELD");
await Bun.stdin.text();
release();
console.log("RELEASED");`,
      ],
      { env: process.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    const stdout = child.stdout.getReader();
    try {
      const held = await stdout.read();
      expect(new TextDecoder().decode(held.value).trim()).toBe("HELD");
      const before = [...f.calls];
      expect(await prepareBridgeDone({ d, scope, target, store, connection })).toEqual({
        kind: "deferred",
        resource,
        id: lane.id,
      });
      expect(f.calls).toEqual(before);
      expect(d.store.lane("audit")?.status).toBe("ready");
      child.stdin.end();
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stderr).text()).toBe("");
      const released = await stdout.read();
      expect(new TextDecoder().decode(released.value).trim()).toBe("RELEASED");
      const prepared = await prepareBridgeDone({ d, scope, target, store, connection });
      if (prepared.kind !== "prepared") throw new Error("Explicit release did not free the target");
      using owned = prepared;
      await owned.execute();
      expect(d.store.lane("audit")?.status).toBe("done");
      expect((await store.owned(lane, true)).closed).toBe(true);
      expect(f.calls.slice(before.length).filter((method) => method === "thread/unsubscribe")).toHaveLength(1);
      expect(f.calls.slice(before.length).filter((method) => method === "turn/start")).toHaveLength(0);
    } finally {
      child.stdin.end();
      child.kill();
      await child.exited;
      stdout.releaseLock();
    }
  },
);
