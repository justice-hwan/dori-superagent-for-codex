import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRuntime } from "../src/daemon.ts";
import { Sessions, socketPath } from "../src/sessions.ts";
import { Store } from "../src/store.ts";
import { send } from "../src/harness.ts";
import { spawnExec } from "../src/process.ts";
const home = mkdtempSync(join(tmpdir(), "dori-codex-live-"));
const sessions = new Sessions(home);
let id: string | undefined;
try {
  await ensureRuntime(home);
  const account = await sessions.call<{ signedIn: boolean }>("account");
  if (!account.signedIn) throw new Error("Sign in with codex login before this explicit live-model test");
  id = await sessions.call("create", { name: "smoke", cwd: process.cwd(), instructions: "This is a transport smoke test. Do not use tools. Reply only with the requested marker.", readOnly: true });
  const store = new Store(home); store.setRole("lead", id!);
  const d = { store, sessions, exec: spawnExec, now: Date.now, doriCmd: "unused", host: () => ({ load1: 0, cores: 1, memFreePct: 100 }) };
  await send(d, "lead", "Reply exactly DORI_CODEX_SMOKE_OK", "smoke");
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && await sessions.status(id!) === "working") await Bun.sleep(200);
  const status = await sessions.status(id!);
  const output = (await sessions.read(id!)).trim();
  if (status !== "done" || output !== "DORI_CODEX_SMOKE_OK") throw new Error(`Smoke failed: status=${status}, output=${JSON.stringify(output)}`);
  if (store.queued(id!).length) throw new Error("Smoke inbox was not acknowledged");
  await sessions.call("shutdown");
  for (let n = 0; n < 100 && existsSync(socketPath(home)); n++) await Bun.sleep(50);
  if (existsSync(socketPath(home)) || existsSync(join(home, "runtime.lock"))) throw new Error("Smoke shutdown remains unconfirmed; inspect the retained runtime before restarting");
  await ensureRuntime(home);
  if (!["idle", "done"].includes(await sessions.status(id!)) || (await sessions.read(id!)).trim() !== output) throw new Error("Used thread did not resume after runtime restart");
  console.log(JSON.stringify({ marker: output, status, resumed: true, threadId: id, home }));
} finally {
  if (id) {
    const status = await sessions.status(id).catch(() => "unknown");
    if (status === "working" || status === "blocked") await sessions.call("interrupt", { threadId: id }).catch(() => {});
    if (status === "done" || status === "idle") await sessions.close(id).catch(() => {});
  }
  await sessions.call("shutdown").catch(() => {});
  for (let n = 0; n < 100 && (existsSync(socketPath(home)) || existsSync(join(home, "runtime.lock"))); n++) await Bun.sleep(100);
  if (existsSync(socketPath(home)) || existsSync(join(home, "runtime.lock"))) throw new Error(`Smoke cleanup shutdown unconfirmed: ${home}`);
}
