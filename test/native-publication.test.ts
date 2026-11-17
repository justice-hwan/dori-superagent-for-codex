import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { nativeUp } from "../src/native-host.ts";
import { record } from "../src/runtime/codex-transport.ts";
import { nativeDeps } from "./native-deps.ts";
import { nativeSetup } from "./native-setup.ts";

test.each(["absolute", "relative"])(
  "a real child using the %s operator home reports and becomes READY from a deeper cwd before bootstrap ACK",
  async (home) => {
    const f = nativeSetup("hold-first");
    const cwd = join(f.cwd, "nested", "lane");
    mkdirSync(cwd, { recursive: true });
    if (home === "relative") f.env["DORI_HOME"] = relative(f.cwd, f.home);
    const brief = join(f.root, "early.md");
    writeFileSync(brief, "Immediately report and become READY.");
    const child = f.spawn("start", "early-lane", "--brief", brief, "--cwd", cwd);
    const finished = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const callbacks: { code: number; stderr: string }[] = [];
    try {
      await Promise.race([
        f.waitQueued(1),
        finished.then(() => {
          throw new Error("startup exited before admission");
        }),
      ]);
      const input = f.queued[0]?.["input"];
      if (!Array.isArray(input) || !record(input[0]) || typeof input[0]["text"] !== "string")
        throw new Error("No queued native bootstrap");
      // Execute the rendered CLI context, without asserting the surrounding prompt prose.
      const command = /`(DORI_RUNTIME=codex [^`\n]+) report /.exec(input[0]["text"])?.[1];
      if (!command) throw new Error("No native callback command");
      for (const action of [
        "report early-lane --text 'Report before ACK.'",
        `ready early-lane --text 'Ready before ACK.' --evidence '${brief}'`,
      ]) {
        const callback = Bun.spawn(["/bin/sh", "-c", `${command} ${action}`], {
          cwd,
          env: f.env,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, , stderr] = await Promise.all([
          callback.exited,
          new Response(callback.stdout).text(),
          new Response(callback.stderr).text(),
        ]);
        callbacks.push({ code, stderr });
      }
    } finally {
      f.setMode("normal");
      f.releaseQueued();
      await finished;
    }
    expect(callbacks).toMatchObject([{ code: 0 }, { code: 0 }]);
    expect((await finished)[0]).toBe(0);
    const lane = JSON.parse(readFileSync(join(f.home, "lanes", "early-lane.json"), "utf8"));
    expect(lane.status).toBe("ready");
    expect(lane.final.text).toBe("Ready before ACK.");
    expect(lane.log.filter((row: { kind: string }) => row.kind === "report")).toHaveLength(1);
    expect(f.queued).toHaveLength(1);
  },
);

test("a positively created lead can register itself and start its first child before bootstrap ACK", async () => {
  const f = nativeSetup("hold-first");
  const { d } = nativeDeps(f);
  const controller = new AbortController();
  const host = nativeUp(d, f.cwd, controller.signal).then(
    () => undefined,
    (error: unknown) => error,
  );
  const brief = join(f.root, "child.md");
  writeFileSync(brief, "First child of a positively created lead.");
  let before: string | undefined;
  let registered: Awaited<ReturnType<typeof f.run>> | undefined;
  let started: Awaited<ReturnType<typeof f.run>> | undefined;
  try {
    await Promise.race([
      f.waitQueued(1),
      host.then(() => {
        throw new Error("host exited before admission");
      }),
    ]);
    const id = [...f.threads.keys()][0];
    if (!id) throw new Error("No created native lead");
    before = d.store.roles().lead?.id;
    f.env["DORI_SELF"] = `codex:${id}`;
    registered = await f.run("role", "lead");
    started = await f.run("start", "first-child", "--brief", brief);
    expect(f.queued.filter((q) => q["threadId"] === id)).toHaveLength(1);
  } finally {
    controller.abort();
    f.setMode("normal");
    f.releaseQueued();
    await host;
  }
  expect(before).toBe([...f.threads.keys()][0]);
  expect(registered?.code).toBe(0);
  expect(started?.code).toBe(0);
  expect(d.store.lane("first-child")?.status).toBe("working");
  expect(await host).toBeUndefined();
});
