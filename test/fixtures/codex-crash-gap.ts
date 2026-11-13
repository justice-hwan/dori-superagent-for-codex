import { defaultDeps } from "../../src/harness.ts";
import { send } from "../../src/inbox.ts";
import { Store } from "../../src/store.ts";
import type { QueuedMessage } from "../../src/store-types.ts";
import type { SessionRef } from "../../src/runtime/types.ts";

class CrashAtSettlement extends Store {
  override updateInbox(ref: SessionRef, update: (messages: readonly QueuedMessage[]) => readonly QueuedMessage[]): QueuedMessage[] {
    const next = super.updateInbox(ref, (messages) => {
      const result = update(messages);
      if (result.length === 0 && process.argv[3] !== "after") process.exit(77);
      return result;
    });
    if (next.length === 0) process.exit(77);
    return next;
  }
}
if (import.meta.main) {
  const d = defaultDeps();
  const target = process.argv[2];
  if (!target) throw new TypeError("Missing target");
  await send({ ...d, store: new CrashAtSettlement(d.store.root) }, target, "crash-gap-payload", "test");
  process.exit(2);
}
