import { defaultDeps } from "../../src/harness.ts";
import { send } from "../../src/inbox.ts";
import { Store } from "../../src/store.ts";
import type { QueuedMessage } from "../../src/store-types.ts";
import type { SessionRef } from "../../src/runtime/types.ts";

class CrashAtSettlement extends Store {
  override saveInbox(ref: SessionRef, messages: readonly QueuedMessage[]): void {
    if (messages.length === 0) {
      if (process.argv[3] === "after") super.saveInbox(ref, messages);
      process.exit(77);
    }
    super.saveInbox(ref, messages);
  }
}
if (import.meta.main) {
  const d = defaultDeps();
  const target = process.argv[2];
  if (!target) throw new TypeError("Missing target");
  await send({ ...d, store: new CrashAtSettlement(d.store.root) }, target, "crash-gap-payload", "test");
  process.exit(2);
}
