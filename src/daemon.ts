import { openSync, closeSync, existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { stateHome } from "./paths.ts";
import { Sessions } from "./sessions.ts";
import { OWNED, readConnection, saveConnection, sameConnection, type Connection } from "./connection.ts";

/** Launch only our own local runtime; never restart or change the user's shared Codex daemon. */
export async function ensureRuntime(home: string, autoLoop = false, requested?: Connection): Promise<void> {
  home = stateHome(home);
  const selected = requested ?? readConnection(home);
  const client = new Sessions(home);
  const health = async () => { try { return await client.call<{ stopping: boolean; shutdownError?: string; connection?: Connection }>("health"); } catch { return undefined; } };
  const assertReady = (h: { stopping: boolean; shutdownError?: string; connection?: Connection }) => {
    if (h.stopping) throw new Error(`Dori runtime is stopping; wait for verified shutdown before starting${h.shutdownError ? ` (${h.shutdownError})` : ""}`);
    if (!sameConnection(h.connection ?? OWNED, selected)) throw new Error("running Dori connection mode, endpoint or lead differs; down and use a separate DORI_HOME before changing connections");
  };
  const existing = await health();
  if (existing) { assertReady(existing); return; }
  if ((selected.mode === "shared" || !sameConnection(readConnection(home), selected)) && existsSync(join(home, "runtime.lock"))) throw new Error("runtime ownership exists but health is unavailable; connection change/start refused until inspected");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  saveConnection(home, selected);
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
    const current = await health();
    if (current) { assertReady(current); return; }
    if (child.exitCode !== null) throw new Error("Dori runtime exited during startup; inspect runtime.log");
  }
  // No blind restart: the first process may still complete initialize after this deadline.
  throw new Error("Dori runtime startup is unconfirmed; inspect runtime.log before retrying");
}
