import { expect, test } from "bun:test";
import { once } from "node:events";
import { closeSync, constants, createReadStream, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { object, text } from "../src/runtime/codex/protocol.ts";
import { CodexStore } from "../src/runtime/codex/store.ts";
import { probeWorker } from "../src/runtime/codex/workers.ts";
import { fixture } from "./codex-fixture.test.ts";

test("launcher SIGKILL before registration cannot leave an executing unowned worker", async () => {
  const f = await fixture();
  const ref = await f.rt.create({ ...f.spec, role: "hourly-loop" });
  const store = new CodexStore(f.root);
  const entry = await store.owned(ref);
  const path = join(store.directory, `${ref.id}.log`);
  const fifo = Bun.spawn(["/usr/bin/mkfifo", "-m", "600", path], {
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect({ code: await fifo.exited, error: await new Response(fifo.stderr).text() }).toEqual({
    code: 0,
    error: "",
  });
  let anchor: number | undefined = openSync(path, constants.O_RDWR | constants.O_NONBLOCK);
  const output = createReadStream(path, { encoding: "utf8" });
  const outcome = Promise.withResolvers<"executed" | "exited">();
  const ended = Promise.withResolvers<void>();
  output.once("data", () => outcome.resolve("executed"));
  output.once("end", () => {
    outcome.resolve("exited");
    ended.resolve();
  });
  output.once("error", (error) => {
    outcome.reject(error);
    ended.reject(error);
  });
  let launcher: ReturnType<typeof Bun.spawn> | undefined;
  f.cleanup.push(async () => {
    if (anchor !== undefined) closeSync(anchor);
    if (launcher) {
      if (launcher.exitCode === null) launcher.kill("SIGKILL");
      await launcher.exited;
    }
    const barrier = Bun.file(join(store.directory, `${ref.id}.registration-fixture`));
    if (await barrier.exists()) {
      const observed = object(await barrier.json());
      const pid = observed["pid"];
      if (typeof pid !== "number") throw new TypeError("Missing owned worker PID");
      const owned = { ...entry, pid, birth: text(observed["birth"]) };
      if ((await probeWorker(owned)).status === "working") process.kill(-pid, "SIGKILL");
    }
    await ended.promise;
    output.destroy();
  });
  await once(output, "open");
  const child = Bun.spawn(
    [process.execPath, fileURLToPath(new URL("./fixtures/codex-worker-registration.ts", import.meta.url)), ref.id],
    {
      env: { ...f.env, DORI_HOME: f.root, BUN_BIN: process.execPath, DORI_TELEMETRY: "0" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  launcher = child;
  const reader = child.stdout.getReader();
  let line = "";
  while (!line.includes("\n")) {
    const part = await reader.read();
    if (part.done) throw new Error(`Launcher exited before registration: ${await new Response(child.stderr).text()}`);
    line += new TextDecoder().decode(part.value);
  }
  reader.releaseLock();
  const observed = object(JSON.parse(line.trim()));
  const pid = observed["pid"];
  const birth = observed["birth"];
  if (typeof pid !== "number" || typeof birth !== "string") throw new TypeError("Invalid owned registration barrier");
  expect(observed["id"]).toBe(ref.id);
  expect(typeof observed["pid"]).toBe("number");
  expect(typeof observed["birth"]).toBe("string");
  expect((await store.owned(ref)).pid).toBeUndefined();
  closeSync(anchor);
  anchor = undefined;

  child.kill("SIGKILL");
  expect(await child.exited).toBe(137);
  const result = await outcome.promise;

  console.info("OWNED_REGISTRATION_BARRIER", { launcher: child.pid, ...observed, registered: false, result });
  expect(result).toBe("exited");
  expect((await probeWorker({ ...entry, pid, birth })).status).toBe("gone");
  expect(await Bun.file(join(f.root, "loop", "last-run.json")).exists()).toBe(false);
  expect((await f.rt.probe(ref)).status).toBe("gone");
  expect(f.calls).toEqual([]);
});
