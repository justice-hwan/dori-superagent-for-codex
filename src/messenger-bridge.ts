import { createHash } from "node:crypto";
import { MessengerJournal, type InboundEnvelope } from "./messenger.ts";
import { flushInbox, Refusal, type Deps } from "./harness.ts";
import { pivot, taskFor } from "./tasks.ts";

/** Called only by an authenticated host adapter. Normalized JSON alone grants no authority. */
export async function admitMessengerRequest(d: Deps, event: InboundEnvelope, options: { ownerId: string; verify: (event: InboundEnvelope) => Promise<boolean>; task?: string }): Promise<void> {
  const journal = new MessengerJournal(d.store.root);
  const result = await journal.acceptInbound(event, options);
  const saved = journal.inbound().find(r => r.event.id === event.id && r.event.origin.platform === event.origin.platform && r.event.origin.account === event.origin.account && r.event.origin.workspace === event.origin.workspace)!;
  if (saved.handledAt) return;
  const source = `messenger-${createHash("sha256").update(JSON.stringify([event.origin.platform, event.origin.account, event.origin.workspace, event.id])).digest("hex")}`;
  if (result.task) {
    const task = taskFor(d, result.task);
    await pivot(d, task.threadId, result.event.text, undefined, source);
  } else {
    const lead = d.store.roles().lead;
    if (!lead) throw new Refusal("no work lead is registered; inbound remains unhandled");
    d.store.enqueueOnce(lead, { id: source, at: saved.receivedAt, from: source,
      text: `[MESSENGER REQUEST ${source}]\nCaptured origin: ${JSON.stringify(result.event.origin)}\nOwner request: ${result.event.text}\nCreate or identify the task, then bind its native thread instance to this captured origin with messenger bind. Raw progress stays internal; replies use the bound origin only.` });
    // Local durable admission, independent of whether the busy coordinator can receive now.
    journal.markInboundHandled(event.origin.platform, event.origin.account, event.id, event.origin.workspace);
    await flushInbox(d, lead); return;
  }
  journal.markInboundHandled(event.origin.platform, event.origin.account, event.id, event.origin.workspace);
}
