import { openSync, closeSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { stateHome } from "./paths.ts";
import { Sessions } from "./sessions.ts";

/** Launch only our own local runtime; never restart or change the user's shared Codex daemon. */
export async function ensureRuntime(home: string, autoLoop = false): Promise<void> {
  home = stateHome(home);
  const client = new Sessions(home);
  try { await client.call("health"); return; } catch { /* not running */ }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const fd = openSync(join(home, "runtime.log"), "a", 0o600);
  const child = spawn(process.execPath, [join(import.meta.dir, "cli.ts"), "serve"], {
    detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, DORI_HOME: home, DORI_AUTO_LOOP: autoLoop ? "1" : "0" },
  });
  closeSync(fd); child.unref();
  let failure: Error | undefined;
  child.once("error", (e) => { failure = e; });
  for (let n = 0; n < 150; n++) {
    if (failure) throw failure;
    await Bun.sleep(100);
    try { await client.call("health"); return; } catch { /* wait for initialize */ }
    if (child.exitCode !== null) throw new Error("Dori runtime exited during startup; inspect runtime.log");
  }
  // No blind restart: the first process may still complete initialize after this deadline.
  throw new Error("Dori runtime startup is unconfirmed; inspect runtime.log before retrying");
}
