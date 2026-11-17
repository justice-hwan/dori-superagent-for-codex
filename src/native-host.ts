import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./cli-args.ts";
import { runDuty, runLoop } from "./cli-loops.ts";
import { promptsDir, type Deps } from "./harness.ts";
import { acquire, release } from "./loop-lock.ts";
import { nativeGuard } from "./native-guard.ts";
import { Refusal } from "./refusal.ts";
import { refText } from "./refs.ts";
import { launchAgent } from "./runtime/launch-agent.ts";

/** Foreground owner of the ORIGINAL two runners. Native threads outlive this host; shutdown never archives them. */
export async function nativeUp(d: Deps, cwd: string, outer?: AbortSignal): Promise<void> {
  const rt = d.runtimes.default;
  if (rt.kind !== "codex") throw new Refusal("native host requires the native runtime");
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  outer?.addEventListener("abort", stop, { once: true });
  if (outer?.aborted) stop();
  let phase = "starting";
  const states = { duty: "not-started", hourly: "not-started" };
  try {
    const guard = await nativeGuard(d.store.root, "host", () => ({
      phase,
      pid: process.pid,
      duty: states.duty === "running" && d.store.stop("duty") ? "paused" : states.duty,
      hourly: states.hourly === "running" && d.store.stop() ? "paused" : states.hourly,
    }));
    try {
      const lock = d.store.lockPath("duty");
      const held = acquire(d, lock);
      if ("holder" in held) throw new Refusal(`another duty runner owns this home (${held.holder})`);
      try {
        for (const [role, ref] of Object.entries(d.store.roles())) {
          if (role !== "lead" && role !== "duty")
            throw new Refusal("native loops are host tasks, not stored session refs");
          rt.assertOwned(ref);
        }
        for (const lane of d.store.lanes())
          if (lane.status !== "done" && lane.status !== "lost") rt.assertOwned(lane.sessionRef);
        for (const ref of d.store.inboxPanes()) rt.assertOwned(ref);
        const launchRole = (role: "lead" | "duty") => {
          const name = role === "lead" ? "lead.md" : "duty-native.md";
          return launchAgent(
            d,
            { name: role, cwd, role, container: "tab", env: {} },
            role,
            async (command, ref) => {
              d.store.setRole(role, ref);
              return readFileSync(join(promptsDir(), name), "utf8").replaceAll("{{dori}}", command);
            },
            "",
          );
        };
        if (controller.signal.aborted) return;
        const lead = await launchRole("lead");
        if (controller.signal.aborted) return;
        const duty = await launchRole("duty");
        if (controller.signal.aborted) return;
        phase = "running";
        states.duty = "running";
        states.hourly = "running";
        const jobs = [
          runDuty(d, parse(["duty", "--interval", "60"]), undefined, controller.signal, held).finally(() => {
            states.duty = "stopped";
          }),
          runLoop(d, parse(["loop"]), undefined, controller.signal).finally(() => {
            states.hourly = "stopped";
          }),
        ];
        console.log(
          `UP runtime=codex lead=${refText(lead)} duty=${refText(duty)} host=${process.pid} foreground home=${d.store.root}`,
        );
        try {
          await Promise.race(jobs);
          if (!controller.signal.aborted) throw new Refusal("native host runner exited unexpectedly");
        } finally {
          phase = "stopping";
          controller.abort();
          await Promise.allSettled(jobs);
        }
      } finally {
        release(d, held.nonce, lock);
      }
    } finally {
      await guard[Symbol.asyncDispose]();
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    outer?.removeEventListener("abort", stop);
  }
}
