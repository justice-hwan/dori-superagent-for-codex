import { expect, onTestFinished, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import { takeManagedSubmit } from "../src/runtime/codex/submit-lock.ts";
import { CodexStore } from "../src/runtime/codex/store.ts";
import { fixture } from "./codex-fixture.test.ts";

test("submit hint is published after gate release and cannot unlink a successor", async () => {
  const f = await fixture();
  const ref = await f.rt.create(f.spec);
  const store = new CodexStore(f.root);
  const path = `${store.path(ref.id)}.submit-lock`;
  const marker = `${store.path(ref.id)}.submit-released`;
  const initial = fs.readFileSync(marker, "utf8");
  const release = takeManagedSubmit(store, ref.id);
  if (!release) throw new Error("Missing actual reservation");
  expect(fs.readFileSync(marker, "utf8")).toBe(initial);
  const rename = fs.renameSync;
  let successor: (() => void) | undefined;
  let successorBytes: string | undefined;
  const publish = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (to === marker) {
      using gate = new Database(`${path}.gate.sqlite`);
      expect(() => gate.exec("BEGIN IMMEDIATE; ROLLBACK")).not.toThrow();
      successor = takeManagedSubmit(store, ref.id);
      expect(successor).toBeDefined();
      successorBytes = fs.readFileSync(path, "utf8");
    }
    return rename(from, to);
  });
  onTestFinished(() => {
    publish.mockRestore();
    release();
    successor?.();
  });
  release();
  if (successorBytes === undefined) throw new Error("Successor acquisition barrier was not reached");
  expect(fs.readFileSync(path, "utf8")).toBe(successorBytes);
  expect(fs.readFileSync(marker, "utf8")).toMatch(/^[0-9a-f-]{36}$/);
  const generation = fs.readFileSync(marker, "utf8");
  release();
  expect(fs.readFileSync(marker, "utf8")).toBe(generation);
  publish.mockRestore();
  successor?.();
  expect(fs.readFileSync(marker, "utf8")).not.toBe(generation);
});

test("hint publication failure preserves the primary failure and releases the gate", async () => {
  const f = await fixture();
  const ref = await f.rt.create(f.spec);
  const store = new CodexStore(f.root);
  const marker = `${store.path(ref.id)}.submit-released`;
  const initial = fs.readFileSync(marker, "utf8");
  const release = takeManagedSubmit(store, ref.id);
  if (!release) throw new Error("Missing actual reservation");
  const write = fs.writeFileSync;
  const failed = spyOn(fs, "writeFileSync").mockImplementation((path, ...args) => {
    if (String(path).startsWith(`${marker}.`)) throw new Error("Fixture marker disk failure");
    return write(path, ...args);
  });
  const diagnostics: unknown[] = [];
  const stderr = spyOn(process.stderr, "write").mockImplementation((value) => {
    diagnostics.push(value);
    return true;
  });
  onTestFinished(() => {
    failed.mockRestore();
    stderr.mockRestore();
  });
  const primary = new Error("Actual operation failure");
  const outcome = () => {
    try {
      throw primary;
    } finally {
      release();
    }
  };
  expect(outcome).toThrow(primary);
  expect(diagnostics.join("")).toContain("Fixture marker disk failure");
  expect(fs.readFileSync(marker, "utf8")).toBe(initial);
  using gate = new Database(`${store.path(ref.id)}.submit-lock.gate.sqlite`);
  expect(() => gate.exec("BEGIN IMMEDIATE; ROLLBACK")).not.toThrow();
});

test("worker and ordinary legacy locks acquire without a managed release hint", async () => {
  const f = await fixture();
  const store = new CodexStore(f.root);
  await store.init();
  const id = `worker-${crypto.randomUUID()}`;
  const release = takeManagedSubmit(store, id);
  expect(release).toBeDefined();
  release?.();
  expect(fs.existsSync(`${store.path(id)}.submit-released`)).toBe(false);
});
