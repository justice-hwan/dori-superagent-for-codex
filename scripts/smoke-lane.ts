import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensureRuntime } from "../src/daemon.ts";
import { Sessions, socketPath } from "../src/sessions.ts";
import { Store } from "../src/store.ts";
import { done } from "../src/harness.ts";
import { shq, spawnExec } from "../src/process.ts";
import { stateHome } from "../src/paths.ts";
const project = stateHome(mkdtempSync(join(tmpdir(), "dori-lane-project-")));
const store = new Store(mkdtempSync(join(tmpdir(), "dori-lane-state-"))), home = store.root;
const sessions = new Sessions(home), key = "smoke-lane", evidence = join(project, "evidence.txt");
const cli = `DORI_HOME=${shq(home)} ${shq(process.execPath)} ${shq(resolve(import.meta.dir, "../src/cli.ts"))}`;
let id: string | undefined, result: unknown;
try {
  await ensureRuntime(home); store.setStop(Date.now(), "isolate smoke notifications", "duty");
  id = await sessions.create(key, project, "This is a sandboxed local lane smoke test. Follow the explicit fixture task only. Never edit Dori state directly, request broader permissions, use network tools, or start other agents. If a command fails, report the failure and stop.");
  const now = Date.now();
  store.saveLane({ key, threadId: id, cwd: project, brief: evidence, status: "working", createdAt: now, lastActivityAt: now, nudges: 0, log: [] });
  // Self-notifications exercise the real local RPC while the same thread stays busy.
  store.setRole("lead", id);
  await sessions.deliver(id, `Create ${evidence} containing DORI_CODEX_LANE_OK. Then execute exactly these two local CLI commands using your command tool:\n${cli} report ${key} --text DORI_CODEX_LANE_REPORT\n${cli} ready ${key} --text DORI_CODEX_LANE_OK --evidence ${shq(evidence)}\nStop if a command fails. Finally reply exactly DORI_CODEX_LANE_OK.`, "live-lane-smoke");
  const deadline = Date.now() + 120_000;
  let status = await sessions.status(id);
  while (status === "working" && Date.now() < deadline) { await Bun.sleep(200); status = await sessions.status(id); }
  if (status !== "done" || (await sessions.read(id)).trim() !== "DORI_CODEX_LANE_OK") throw new Error(`Lane smoke did not complete: ${status}; inspect requests without answering automatically`);
  const lane = store.lane(key)!;
  if (lane.status !== "ready" || !lane.log.some(l => l.kind === "report" && l.text === "DORI_CODEX_LANE_REPORT") || !lane.final?.evidence.some(p => resolve(project, p) === evidence) || readFileSync(evidence, "utf8").trim() !== "DORI_CODEX_LANE_OK") throw new Error("Lane smoke evidence/report/READY was not verified");
  if (!store.queued(id).every(m => m.from === key)) throw new Error("Unexpected smoke inbox input; retained for inspection");
  store.clearInbox(id);
  await done({ store, sessions, exec: spawnExec, now: Date.now, doriCmd: cli, host: () => ({ load1: 0, cores: 1, memFreePct: 100 }) }, key);
  result = { marker: "DORI_CODEX_LANE_OK", selfReported: true, ready: true, closedByLead: true, threadId: id, home, project };
} finally {
  if (id) {
    const status = await sessions.status(id).catch(() => "unknown");
    if (status === "working" || status === "blocked") await sessions.call("interrupt", { threadId: id }).catch(() => {});
    const after = await sessions.status(id).catch(() => "unknown");
    if (["idle", "done", "failed"].includes(after)) await sessions.close(id).catch(() => {});
  }
  await sessions.call("shutdown").catch(() => {});
  for (let n = 0; n < 100 && (existsSync(socketPath(home)) || existsSync(join(home, "runtime.lock"))); n++) await Bun.sleep(100);
  if (existsSync(socketPath(home)) || existsSync(join(home, "runtime.lock"))) throw new Error(`Lane smoke shutdown unconfirmed: ${home}`);
}
console.log(JSON.stringify(result));
