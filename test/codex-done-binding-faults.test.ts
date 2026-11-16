import { Database } from "bun:sqlite";
import { expect, onTestFinished, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DoneTarget } from "../src/runtime/codex/done-target.ts";
import { MessageJournal } from "../src/runtime/codex/message-journal.ts";
import type { ManagementFinal } from "../src/runtime/codex/message-schema.ts";
import { CodexStore } from "../src/runtime/codex/store.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dori-done-faults-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const store = new CodexStore(root);
  await store.init();
  const source = crypto.randomUUID();
  const final: ManagementFinal = {
    source: { threadId: source, turnId: "turn-done", itemId: "final-done" },
    action: { tool: "dori_done", arguments: { key: "lane-one" } },
  };
  const target: DoneTarget = {
    runtime: "codex",
    id: crypto.randomUUID(),
    cwd: root,
    key: "lane-one",
    createdAt: 123,
    admissionId: "admission-one",
    admissionOrder: 1,
    readyHash: "a".repeat(64),
  };
  const imports = `
    import {MessageJournal} from ${JSON.stringify(new URL("../src/runtime/codex/message-journal.ts", import.meta.url).pathname)};
    import {CodexStore} from ${JSON.stringify(new URL("../src/runtime/codex/store.ts", import.meta.url).pathname)};
    const journal = new MessageJournal(new CodexStore(${JSON.stringify(root)}), ${JSON.stringify(source)});
    const final = ${JSON.stringify(final)}, root = ${JSON.stringify(root)};
  `;
  return { root, store, source, final, target, imports, path: `${store.path(source)}.messages.sqlite` };
}

test("every malformed durable identity field fails closed without reserving or consuming", async () => {
  const f = await fixture();
  using journal = new MessageJournal(f.store, f.source);
  const binding = journal.bindDoneTarget(f.final, f.root, f.target);
  using db = new Database(f.path);
  const badBindings: unknown[] = [
    null,
    [],
    {},
    { ...binding, target: null },
    { ...binding, extra: true },
    { ...binding, target: { ...f.target, extra: true } },
  ];
  for (const field of ["sourceThread", "turn", "item", "action", "actionHash", "sourceCwd"]) {
    badBindings.push({ ...binding, [field]: null }, { ...binding, [field]: "" }, { ...binding, [field]: 12 });
    const missing: Record<string, unknown> = { ...binding };
    delete missing[field];
    badBindings.push(missing);
  }
  for (const field of ["runtime", "id", "cwd", "key", "createdAt", "admissionId", "admissionOrder", "readyHash"]) {
    badBindings.push({ ...binding, target: { ...f.target, [field]: {} } });
    const missing: Record<string, unknown> = { ...f.target };
    delete missing[field];
    badBindings.push({ ...binding, target: missing });
  }
  for (const target of [
    { ...f.target, runtime: "other" },
    { ...f.target, id: "invalid" },
    { ...f.target, id: f.source },
    { ...f.target, cwd: "relative" },
    { ...f.target, createdAt: -1 },
    { ...f.target, createdAt: 0.5 },
    { ...f.target, admissionOrder: -1 },
    { ...f.target, admissionOrder: 0.5 },
    { ...f.target, admissionOrder: null },
    { ...f.target, admissionId: null },
    { ...f.target, readyHash: "invalid" },
  ])
    badBindings.push({ ...binding, target });
  const changedAction = JSON.stringify({ tool: "dori_done", arguments: { key: "another-key" } });
  badBindings.push(
    { ...binding, sourceThread: crypto.randomUUID() },
    { ...binding, sourceCwd: "relative" },
    { ...binding, actionHash: "b".repeat(64) },
    { ...binding, action: "{" },
    { ...binding, action: changedAction, actionHash: createHash("sha256").update(changedAction).digest("hex") },
  );
  for (const bad of badBindings) {
    db.run("UPDATE close_targets SET binding=?", [JSON.stringify(bad)]);
    expect(() => journal.doneTarget(f.final, f.root)).toThrow("durable done binding");
    expect(() => journal.bindDoneTarget(f.final, f.root, f.target)).toThrow("durable done binding");
    expect(() => journal.reserve(f.final, binding)).toThrow("durable done binding");
    expect(journal.seen(f.final.source.turnId)).toBe(false);
  }
  db.run("UPDATE close_targets SET binding=?", [JSON.stringify(binding)]);
  for (const version of [0, 2, "invalid"]) {
    db.run("UPDATE close_targets SET version=?", [version]);
    expect(() => journal.doneTarget(f.final, f.root)).toThrow("durable done binding");
    expect(() => journal.reserve(f.final, binding)).toThrow("durable done binding");
  }
  db.run("UPDATE close_targets SET version=1");
  expect(journal.doneTarget(f.final, f.root)).toEqual(binding);
  expect(journal.effect(f.final.source.turnId)).toBeUndefined();
  expect(() => journal.assertSettled()).not.toThrow();
});

test("a supplied binding cannot manufacture authority when its durable row is missing", async () => {
  const f = await fixture();
  using journal = new MessageJournal(f.store, f.source);
  const binding = journal.bindDoneTarget(f.final, f.root, f.target);
  using db = new Database(f.path);
  db.run("DELETE FROM close_targets");
  expect(() => journal.reserve(f.final, binding)).toThrow("durable done binding");
  expect(journal.effect(f.final.source.turnId)).toBeUndefined();
});

test("SIGKILL after FULL binding commit preserves intent without consuming or reserving", async () => {
  const f = await fixture();
  const script = `${f.imports}
    journal.bindDoneTarget(final, root, ${JSON.stringify(f.target)});
    process.kill(process.pid, "SIGKILL");
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  onTestFinished(async () => {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  });
  await child.exited;
  expect(child.signalCode).toBe("SIGKILL");
  using journal = new MessageJournal(f.store, f.source);
  expect(journal.doneTarget(f.final, f.root)?.target).toEqual(f.target);
  expect(journal.seen(f.final.source.turnId)).toBe(false);
  expect(journal.effect(f.final.source.turnId)).toBeUndefined();
  expect(() => journal.assertSettled()).not.toThrow();
});

test("a process exiting immediately after reserve cannot replay after reopen", async () => {
  const f = await fixture();
  {
    using journal = new MessageJournal(f.store, f.source);
    journal.bindDoneTarget(f.final, f.root, f.target);
  }
  const script = `${f.imports}
    console.log(journal.reserve(final, journal.doneTarget(final, root)));
    process.exit(0);
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  onTestFinished(() => child.kill());
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, stdout: stdout.trim(), stderr }).toEqual({ code: 0, stdout: "new", stderr: "" });
  using journal = new MessageJournal(f.store, f.source);
  const binding = journal.doneTarget(f.final, f.root);
  expect(binding?.target).toEqual(f.target);
  expect(journal.reserve(f.final, binding)).toBe("existing");
  expect(() => journal.assertSettled()).toThrow("never replay");
  expect(journal.claim()).toBeUndefined();
  expect(journal.effect(f.final.source.turnId)).toMatchObject({ state: "dispatching", receipt: "queued" });
  using db = new Database(f.path, { readonly: true });
  expect(db.query("SELECT COUNT(*) AS n FROM effects").get()).toEqual({ n: 1 });
});

test("concurrent processes cannot bind one source turn to two different targets", async () => {
  const f = await fixture();
  const targets = [f.target, { ...f.target, id: crypto.randomUUID() }];
  const children = [];
  for (const target of targets) {
    const script = `${f.imports}
      console.log("READY");
      await Bun.stdin.text();
      try {
        console.log(JSON.stringify({kind:"bound", target:journal.bindDoneTarget(final, root, ${JSON.stringify(target)}).target.id}));
      } catch (error) {
        console.log(JSON.stringify({kind:"refused", error:String(error)}));
      }
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: process.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    onTestFinished(() => child.kill());
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value).trim()).toBe("READY");
    children.push({ child, reader });
  }
  for (const { child } of children) child.stdin.end();
  const outputs = await Promise.all(
    children.map(async ({ child, reader }) => {
      let stdout = "";
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        stdout += new TextDecoder().decode(part.value);
      }
      return { code: await child.exited, stdout, stderr: await new Response(child.stderr).text() };
    }),
  );
  expect(outputs.map((output) => output.code)).toEqual([0, 0]);
  expect(outputs.map((output) => output.stderr)).toEqual(["", ""]);
  expect(outputs.filter((output) => output.stdout.includes('"kind":"bound"'))).toHaveLength(1);
  expect(outputs.filter((output) => output.stdout.includes('"kind":"refused"'))).toHaveLength(1);
  using journal = new MessageJournal(f.store, f.source);
  const binding = journal.doneTarget(f.final, f.root);
  expect(targets.some((target) => target.id === binding?.target.id)).toBe(true);
  for (const target of targets) {
    if (target.id === binding?.target.id) expect(journal.bindDoneTarget(f.final, f.root, target)).toEqual(binding);
    else expect(() => journal.bindDoneTarget(f.final, f.root, target)).toThrow("durable done binding");
  }
  expect(journal.seen(f.final.source.turnId)).toBe(false);
});
