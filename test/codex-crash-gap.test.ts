import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { flushInbox } from "../src/inbox.ts";
import { CodexRuntime } from "../src/runtime/codex/index.ts";
import { Runtimes } from "../src/runtime/registry.ts";
import { Store } from "../src/store.ts";
import { harnessFixture } from "./codex-fixture.test.ts";

test.each([
  { append: false, gap: "before" },
  { append: true, gap: "before" },
  { append: false, gap: "after" },
])("admitted batch is not replayed at $gap settlement; new message=$append", async ({ append, gap }) => {
  const { f, d } = await harnessFixture();
  const ref = await f.rt.create(f.spec);
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL("./fixtures/codex-crash-gap.ts", import.meta.url)),
      `codex:${ref.id}`,
      gap,
    ],
    {
      env: {
        ...process.env,
        ...f.env,
        DORI_HOME: f.root,
        DORI_RUNTIME: "codex",
        DORI_CODEX_BRIDGE: "",
        DORI_TELEMETRY: "0",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect({ code, stderr }).toEqual({ code: 77, stderr: "" });
  f.finish(ref.id, "native completion after sender crash");
  const store = new Store(f.root);
  if (append) store.enqueue(ref, { at: Date.now(), from: "test", text: "crash-gap-payload" });
  const restored = new CodexRuntime(f.root, f.env);

  await flushInbox({ ...d, store, runtimes: new Runtimes("codex", () => restored) }, ref);
  if (gap === "after")
    expect(await restored.deliver(ref, "crash-gap-payload")).toEqual({ kind: "delivered", started: true });

  const messages = f.threads.get(ref.id)?.items.filter((item) => item["type"] === "userMessage");
  expect(messages).toEqual(
    Array.from({ length: append || gap === "after" ? 2 : 1 }, () => ({
      type: "userMessage",
      content: [{ type: "text", text: "crash-gap-payload", text_elements: [] }],
    })),
  );
  expect(store.queued(ref)).toEqual([]);
});
