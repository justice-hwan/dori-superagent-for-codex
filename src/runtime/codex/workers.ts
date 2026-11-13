import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import type { Probe } from "../types.ts";
import { CodexError } from "./protocol.ts";
import type { Environment } from "./threads.ts";
import type { CodexStore, RecordEntry } from "./store.ts";

/** Birth time plus an argv marker proves the wrapper even where macOS hides shell environments. */
const identity = async (pid: number): Promise<string | undefined> => {
  const child = Bun.spawn(["/bin/ps", "eww", "-p", String(pid), "-o", "lstart=", "-o", "command="], {
    env: { ...process.env, LC_ALL: "C" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(child.stdout).text();
  return (await child.exited) === 0 ? output.trim() : undefined;
};

const proven = async (entry: RecordEntry): Promise<boolean> => {
  if (!entry.pid || !entry.birth) return false;
  const current = await identity(entry.pid);
  return (
    current !== undefined &&
    current.slice(0, 24) === entry.birth &&
    current.split(/\s+/).includes(`dori-codex-worker=${entry.id}`)
  );
};

export const startWorker = async (
  store: CodexStore,
  entry: RecordEntry,
  command: string,
  env: Environment,
): Promise<void> => {
  if (entry.pid) throw new CodexError("unsupported", "Worker was already started");
  const suffix = entry.spec.role === "duty-loop" ? / duty --interval [1-9][0-9]*$/ : / loop$/;
  if (!suffix.test(command)) throw new CodexError("unsupported", "Worker command does not match its loop role");
  const output = openSync(join(store.directory, `${entry.id}.log`), "a", 0o600);
  // The trailing exit keeps a stable wrapper PID instead of a shell exec optimization.
  const child = spawn("/bin/sh", ["-c", `${command}\nstatus=$?\nexit "$status"`, `dori-codex-worker=${entry.id}`], {
    env: { ...env, ...entry.spec.env, DORI_HOME: store.root, DORI_RUNTIME: "codex", DORI_CODEX_WORKER: entry.id },
    cwd: entry.spec.cwd,
    detached: true,
    stdio: ["ignore", output, output],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } finally {
    closeSync(output);
  }
  child.unref();
  const pid = child.pid;
  if (!pid) throw new CodexError("unsupported", "Worker did not receive a PID");
  const current = await identity(pid);
  await store.save({ ...entry, pid, ...(current ? { birth: current.slice(0, 24) } : {}) });
};

export const probeWorker = async (entry: RecordEntry): Promise<Probe> => ({
  status: (await proven(entry)) ? "working" : "gone",
  shellInFront: false,
  ...(entry.pid ? { rootPid: entry.pid } : {}),
  cwd: entry.spec.cwd,
});

export const readWorker = async (store: CodexStore, entry: RecordEntry, lines: number): Promise<string> => {
  const file = Bun.file(join(store.directory, `${entry.id}.log`));
  if (lines <= 0 || !(await file.exists())) return "";
  return (await file.text()).split("\n").slice(-lines).join("\n");
};

export const closeWorker = async (entry: RecordEntry): Promise<void> => {
  if (entry.pid && (await proven(entry))) {
    try {
      process.kill(-entry.pid, "SIGTERM");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
};
