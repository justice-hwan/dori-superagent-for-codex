import { readSync, writeSync } from "node:fs";
import { defaultDeps } from "../../src/harness.ts";
import { releaseHeld } from "../../src/inbox-held.ts";
import { Store } from "../../src/store.ts";
import type { SessionRef } from "../../src/runtime/types.ts";
import type { QueuedMessage } from "../../src/store-types.ts";

const pause = (phase: string) => {
  writeSync(1, `${phase}\n`);
  readSync(0, Buffer.alloc(1));
};

class PausedStore extends Store {
  override saveInbox(ref: SessionRef, messages: readonly QueuedMessage[]): void {
    pause("snapshot");
    super.saveInbox(ref, messages);
  }
  override updateInbox(ref: SessionRef, update: (messages: readonly QueuedMessage[]) => readonly QueuedMessage[]): QueuedMessage[] {
    return super.updateInbox(ref, (messages) => {
      const next = update(messages);
      pause("atomic");
      return next;
    });
  }
}

if (import.meta.main) {
  const root = process.env["DORI_HOME"];
  if (!root) throw new TypeError("Missing test home");
  const ref: SessionRef = { runtime: "herdr", id: "w1:p1" };
  if (process.argv[2] === "append") {
    writeSync(1, "STARTED\n");
    new Store(root).enqueue(ref, { at: 2, from: "lane", text: "READY" });
    writeSync(1, "APPENDED\n");
  } else {
    const how = process.argv[2];
    if (how !== "ack" && how !== "resend") throw new TypeError("Missing recovery action");
    const d = defaultDeps();
    await releaseHeld({ ...d, store: new PausedStore(root) }, "herdr:w1:p1", 1, how);
  }
}
