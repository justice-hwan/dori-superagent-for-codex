import { onTestFinished } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { nativeServer } from "./native-server.ts";

export function nativeSetup(mode = "normal") {
  const root = mkdtempSync("/tmp/dori-native-");
  const home = join(root, "home");
  const osHome = join(root, "os-home");
  const cwd = join(root, "work");
  mkdirSync(home);
  mkdirSync(osHome);
  mkdirSync(cwd);
  const socket = join(root, "codex.sock");
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      runtime: "codex",
      codex: { socket, model: "gpt-test", timeoutMs: 1000, turnTimeoutMs: 2000 },
    }),
  );
  const { server, ...fixture } = nativeServer(socket, mode);
  // Bun writes its macOS transpiler cache under HOME; that is separate from Dori's instance state.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: osHome,
    DORI_HOME: home,
    DORI_RUNTIME: "codex",
    DORI_TELEMETRY: "0",
    DORI_CODEX_SOCKET: socket,
    DORI_CODEX_MODEL: "gpt-test",
    DORI_SELF: "",
    DORI_AGENT_CMD: "FORBIDDEN-OMO",
  };
  const spawn = (...args: string[]) =>
    Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli.ts"), ...args], {
      cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  const run = async (...args: string[]) => {
    const child = spawn(...args);
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  };
  onTestFinished(async () => {
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, home, cwd, socket, env, run, spawn, ...fixture };
}
