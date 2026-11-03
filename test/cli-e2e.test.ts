import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { socketPath } from "../src/sessions.ts";
const cli = join(import.meta.dir, "../src/cli.ts");

test("Unix-socket CLI: up, send, read, approval response, lane READY, close and down", async () => {
  const home = mkdtempSync(join(tmpdir(), "dori-cli-test-"));
  const env = { ...process.env, DORI_HOME: home, DORI_CODEX_BIN: join(import.meta.dir, "fixtures/fake-codex.ts") };
  const run = async (...args: string[]) => {
    const p = Bun.spawn([process.execPath, cli, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code) throw new Error(`CLI ${args[0]} failed: ${err}`); return out.trim();
  };
  try {
    expect(await run("up", "--cwd", home)).toStartWith("UP lead=");
    expect(statSync(socketPath(home)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await run("doctor")).account.signedIn).toBe(true);
    await run("send", "lead", "--text", "CLI_MARKER");
    for (let n = 0; n < 100 && await run("read", "lead") !== "CLI_MARKER"; n++) await Bun.sleep(20);
    expect(await run("read", "lead")).toBe("CLI_MARKER");
    await run("send", "lead", "--text", "APPROVE"); await Bun.sleep(50);
    const requests = JSON.parse(await run("requests")); expect(requests).toHaveLength(1);
    writeFileSync(join(home, "answer.json"), JSON.stringify({ decision: "decline" }));
    await run("requests", "answer", String(requests[0].id), "--json", join(home, "answer.json"));
    const brief = join(home, "brief.md"); writeFileSync(brief, "Fixture task");
    expect(await run("start", "sample-lane", "--brief", brief, "--cwd", home)).toStartWith("STARTED sample-lane thread=");
    await Bun.sleep(50);
    await run("ready", "sample-lane", "--text", "fixture complete", "--evidence", brief);
    await run("done", "sample-lane");
    expect(JSON.parse(readFileSync(join(home, "lanes/sample-lane.json"), "utf8")).status).toBe("done");
    expect(await run("down")).toBe("DOWN"); expect(existsSync(socketPath(home))).toBe(false);
    expect(existsSync(join(home, "telemetry.json"))).toBe(false);
  } finally {
    if (existsSync(join(home, "runtime.lock"))) await run("down").catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
}, 20_000);
