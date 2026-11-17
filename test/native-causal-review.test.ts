import { expect, test } from "bun:test";
import { review } from "../src/gate.ts";
import { nativeDeps } from "./native-deps.ts";
import { nativeSetup } from "./native-setup.ts";
import { World } from "./fake.ts";

const head = "a".repeat(40);

test.each(["different-client", "same-client-different-input"])(
  "an unrelated %s completion cannot supply the native review verdict",
  async (mode) => {
    const f = nativeSetup("never-complete");
    const { d, w } = nativeDeps(f);
    w.gh = () => ({ code: 0, stdout: JSON.stringify({ headRefOid: head }) });
    const pending = review(d, "o/r#17");
    await Promise.race([
      f.waitQueued(1),
      pending.then(() => {
        throw new Error("review exited before input");
      }),
    ]);
    const id = [...f.threads.keys()][0];
    const thread = id === undefined ? undefined : f.threads.get(id);
    const actual = thread?.items.find((entry) => entry.item["type"] === "userMessage");
    if (!id || !thread || !actual) throw new Error("No admitted native input");
    const other = "unrelated-turn";
    thread.items.push({
      turnId: other,
      item: {
        id: "other-user",
        type: "userMessage",
        clientId: mode === "different-client" ? "different-client" : actual.item["clientId"],
        content: [{ type: "text", text: "An unrelated task.", text_elements: [] }],
      },
    });
    const complete = (turnId: string, text: string) => {
      thread.items.push({ turnId, item: { type: "agentMessage", id: `agent-${turnId}`, text } });
      thread.status = "idle";
      for (const peer of f.connections)
        if (peer.data.thread === id)
          peer.send(
            JSON.stringify({
              method: "turn/completed",
              params: { threadId: id, turn: { id: turnId, status: "completed", error: null } },
            }),
          );
    };
    complete(other, "Unrelated task\nVERDICT: CLEAR");
    complete(actual.turnId, "Actual requested review\nVERDICT: BLOCK");
    expect(await pending).toEqual({ verdict: "BLOCK", sha: head });
    expect(d.store.receipt("o/r#17", head)?.verdict).toBe("BLOCK");
    expect(f.queued).toHaveLength(1);
  },
);

test("native and legacy review producers preserve the same public receipt shape", async () => {
  const f = nativeSetup();
  const { d, w } = nativeDeps(f);
  const legacy = new World();
  const old = legacy.deps();
  w.gh = legacy.gh = () => ({ code: 0, stdout: JSON.stringify({ headRefOid: head }) });
  await review(old, "o/r#18");
  await review(d, "o/r#18");
  const nativeReceipt = d.store.receipt("o/r#18", head);
  const legacyReceipt = old.store.receipt("o/r#18", head);
  if (!nativeReceipt || !legacyReceipt) throw new Error("Missing emitted receipt");
  expect(Object.keys(nativeReceipt).sort()).toEqual(Object.keys(legacyReceipt).sort());
  expect(nativeReceipt.model).toBe("gpt-test");
});
