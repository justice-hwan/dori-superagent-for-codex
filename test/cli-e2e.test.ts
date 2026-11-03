import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sessions, socketPath } from "../src/sessions.ts";
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

test("delayed review and submission survive server and client idle limits", async () => {
  const home = mkdtempSync(join(tmpdir(), "dori-slow-review-test-"));
  const env = { ...process.env, DORI_HOME: home, DORI_CODEX_BIN: join(import.meta.dir, "fixtures/fake-codex.ts") };
  const cliRun = async (...args: string[]) => {
    const p = Bun.spawn([process.execPath, cli, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code) throw new Error(err); return out;
  };
  try {
    await cliRun("up", "--cwd", home);
    const script = `import { Sessions } from ${JSON.stringify(join(import.meta.dir, "../src/sessions.ts"))}; const s = new Sessions(${JSON.stringify(home)}); const id = await s.create("slow", ${JSON.stringify(home)}, ""); const [review] = await Promise.all([s.review("SLOW_REVIEW", ${JSON.stringify(home)}), s.deliver(id, "SLOW_START", "slow-batch")]); console.log(review);`;
    const p = Bun.spawn([process.execPath, "-e", script], { env: { ...env, BUN_CONFIG_HTTP_IDLE_TIMEOUT: "1" }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect({ code, err }).toEqual({ code: 0, err: "" }); expect(out.trim()).toBe("VERDICT: CLEAR");
  } finally {
    if (existsSync(join(home, "runtime.lock"))) await cliRun("down").catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
}, 25_000);

test("relative DORI_HOME in different project directories creates independent runtimes", async () => {
  const root = mkdtempSync(join(tmpdir(), "dori-relative-home-")), projects = [join(root, "project-a"), join(root, "project-b")];
  for (const p of projects) mkdirSync(p);
  const env = { ...process.env, DORI_HOME: "state", DORI_CODEX_BIN: join(import.meta.dir, "fixtures/fake-codex.ts") };
  const run = async (cwd: string, ...args: string[]) => {
    const p = Bun.spawn([process.execPath, cli, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code) throw new Error(err); return out;
  };
  try {
    for (const cwd of projects) await run(cwd, "up", "--cwd", cwd);
    const clients = projects.map(p => new Sessions(join(p, "state")));
    expect((await clients[0]!.call("health")).pid).not.toBe((await clients[1]!.call("health")).pid);
    for (const [i, cwd] of projects.entries()) {
      const roles = JSON.parse(readFileSync(join(cwd, "state/roles.json"), "utf8"));
      expect(clients[i]!.known(roles.lead)).toBe(true);
      await run(cwd, "send", "lead", "--text", `project-${i}`);
      for (let n = 0; n < 100 && await clients[i]!.status(roles.lead) !== "done"; n++) await Bun.sleep(10);
      expect(await clients[i]!.read(roles.lead)).toBe(`project-${i}`);
    }
    expect(socketPath(join(projects[0]!, "state"))).not.toBe(socketPath(join(projects[1]!, "state")));
  } finally {
    for (const cwd of projects) if (existsSync(join(cwd, "state/runtime.lock"))) await run(cwd, "down").catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
