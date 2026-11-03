import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MessengerJournal, type InboundEnvelope } from "./messenger.ts";
import { flushInbox, Refusal, type Deps } from "./harness.ts";
import { pivot } from "./tasks.ts";

/** Called only by an authenticated host adapter. Normalized JSON alone grants no authority. */
export async function admitMessengerRequest(d: Deps, event: InboundEnvelope, options: { ownerId: string; verify: (event: InboundEnvelope) => Promise<boolean>; task?: string }): Promise<void> {
  const journal = new MessengerJournal(d.store.root);
  const result = await journal.acceptInbound(event, options);
  const saved = journal.inbound().find(r => r.event.id === event.id && r.event.origin.platform === event.origin.platform && r.event.origin.account === event.origin.account && r.event.origin.workspace === event.origin.workspace)!;
  if (saved.handledAt) return;
  const source = `messenger-${createHash("sha256").update(JSON.stringify([event.origin.platform, event.origin.account, event.origin.workspace, event.id])).digest("hex")}`;
  if (result.task) {
    const task = d.store.lanes().find(l => l.threadId === result.task);
    if (!task || task.status === "done" || task.status === "lost") throw new Refusal("the bound messenger task instance is not open");
    await pivot(d, task.threadId, result.event.text, undefined, source, result.task);
  } else {
    const lead = d.store.roles().lead;
    if (!lead) throw new Refusal("no work lead is registered; inbound remains unhandled");
    const originFile = join(journal.root, `${source}.origin.json`);
    const originText = JSON.stringify(result.event.origin, null, 2) + "\n";
    if (existsSync(originFile)) { if (readFileSync(originFile, "utf8") !== originText) throw new Refusal("captured origin file conflicts with the admitted request"); }
    else writeFileSync(originFile, originText, { mode: 0o600, flag: "wx" });
    d.store.enqueueOnce(lead, { id: source, at: saved.receivedAt, from: source,
      text: `[MESSENGER REQUEST ${source}]\nCaptured origin: ${JSON.stringify(result.event.origin)}\nOrigin file: ${JSON.stringify(originFile)}\nOwner request: ${result.event.text}\nCreate the task with start --origin FILE using that immutable origin file before kickoff; never start first and bind later. Check existing bound instances before creating another task on this route. Raw progress stays internal; replies use the bound origin only.` });
    // Local durable admission, independent of whether the busy coordinator can receive now.
    journal.markInboundHandled(event.origin.platform, event.origin.account, event.id, event.origin.workspace);
    await flushInbox(d, lead); return;
  }
  journal.markInboundHandled(event.origin.platform, event.origin.account, event.id, event.origin.workspace);
}
