import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import type { Probe } from "../types.ts";
import { CodexError } from "./protocol.ts";
import type { Environment } from "./threads.ts";
import type { CodexStore, RecordEntry } from "./store.ts";
import type { pinHostRuntime } from "./bridge-install.ts";

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
  host: ReturnType<typeof pinHostRuntime>,
): Promise<void> => {
  if (entry.pid) throw new CodexError("unsupported", "Worker was already started");
  const suffix = entry.spec.role === "duty-loop" ? / duty --interval [1-9][0-9]*$/ : / loop$/;
  const operation = command.match(suffix)?.[0];
  if (!operation || command.slice(0, -operation.length) !== host.command)
    throw new CodexError("unsupported", "Worker command must use the pinned runtime and match its loop role");
  const output = openSync(join(store.directory, `${entry.id}.log`), "a", 0o600);
  // The trailing exit keeps a stable wrapper PID instead of a shell exec optimization.
  const child = spawn("/bin/sh", ["-c", `${command}\nstatus=$?\nexit "$status"`, `dori-codex-worker=${entry.id}`], {
    env: {
      ...env,
      ...entry.spec.env,
      DORI_HOME: store.root,
      DORI_RUNTIME: "codex",
      DORI_CODEX_WORKER: entry.id,
      DORI_CMD: host.command,
      BUN_BIN: host.executable,
      DORI_CODEX_WORKSPACE: entry.spec.cwd,
    },
    cwd: host.directory,
    detached: true,
    stdio: ["ignore", output, output],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const pid = child.pid;
    if (!pid) throw new CodexError("unsupported", "Worker did not receive a PID");
    const current = await identity(pid);
    if (!current) throw new CodexError("ownership", "Worker identity could not be observed");
    await store.save({ ...entry, pid, birth: current.slice(0, 24) });
    child.unref();
  } catch (error) {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      // The direct child handle proves this newly spawned group, even when
      // identity lookup or its first durable record failed.
      const reaped = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (killError) {
        if (!(killError instanceof Error && "code" in killError && killError.code === "ESRCH")) throw killError;
      }
      await reaped;
    }
    throw error;
  } finally {
    closeSync(output);
  }
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
