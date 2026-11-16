import { expect, test } from "bun:test";
import { MessageJournal } from "../src/runtime/codex/message-journal.ts";
import { CodexStore } from "../src/runtime/codex/store.ts";
import { harnessFixture } from "./codex-fixture.test.ts";

/** A long-lived lead whose history exceeds the bounded page window of 32 pages of 100 turns. */
const longLead = async () => {
  const { f, d } = await harnessFixture();
  const lead = await f.rt.create({ ...f.spec, role: "lead", env: {} });
  d.store.setRole("lead", lead);
  const thread = f.threads.get(lead.id);
  if (!thread) throw new TypeError("Missing lead thread");
  for (let turn = 0; turn < 3300; turn++)
    thread.turns.push({ id: crypto.randomUUID(), items: [], status: "completed", error: null });
  return { f, d, lead, newest: thread.turns.at(-1)?.id ?? "" };
};

test("watcher startup stops its baseline at history the journal already observed", async () => {
  const { f, d, lead, newest } = await longLead();
  {
    using journal = new MessageJournal(new CodexStore(f.root), lead.id);
    journal.observe(newest, "ordinary-or-failed");
  }

  const stop = await f.rt.watchIdle(async () => {}, d);
  f.cleanup.push(stop);

  expect(f.calls).toContain("thread/resume");
});

test("an unobserved backlog beyond the page window still refuses watcher startup", async () => {
  const { f, d } = await longLead();

  const startup = f.rt.watchIdle(async () => {}, d);

  await expect(startup).rejects.toThrow("bounded page window");
});
