import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { NativeState } from "../src/native-state.ts";
import { nativeDeps } from "./native-deps.ts";
import { nativeSetup } from "./native-setup.ts";

for (const fullAccess of [false, true]) {
  test.each(["lost-resume", "resume-model", "resume-provider"])(
    `unconfirmed %s resume suppresses later input with fullAccess=${fullAccess}`,
    async (fault) => {
      const f = nativeSetup();
      writeFileSync(
        join(f.home, "config.json"),
        JSON.stringify({
          runtime: "codex",
          codex: { socket: f.socket, model: "gpt-test", timeoutMs: 1000, turnTimeoutMs: 2000, fullAccess },
        }),
      );
      const spec = { key: "lead", name: "lead", cwd: f.cwd };
      const render = async () => "Accepted bootstrap.";
      const ref = await nativeDeps(f).rt.launchAgent(spec, render);
      const thread = f.threads.get(ref.id);
      if (!thread) throw new Error("Missing owned fixture thread");
      thread.status = "notLoaded";
      f.setMode("hold-read");

      const first = nativeDeps(f).rt.deliver(ref, "Input requiring resume.");
      await f.waitRead();
      f.setMode(fault);
      f.releaseQueued();
      expect(await first).toEqual({ kind: "not-ready", status: "unknown" });
      expect(thread.status).toBe("idle");
      f.setMode("normal");
      const restored = nativeDeps(f).rt;
      const retry = await restored.deliver(ref, "Must not bypass unresolved admission.");

      expect({ retry, inputs: f.queued.map((entry) => entry["input"]) }).toEqual({
        retry: { kind: "not-ready", status: "unknown" },
        inputs: [[{ type: "text", text: "Accepted bootstrap.", text_elements: [] }]],
      });
      expect(new NativeState(f.home).owned(ref.id)?.policyHeld).toBe(true);
      await expect(restored.launchAgent(spec, render)).rejects.toThrow("HELD");
      expect(f.queued).toHaveLength(1);
    },
  );
}
