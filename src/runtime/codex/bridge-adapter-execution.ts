import { AsyncLocalStorage } from "node:async_hooks";
import { pathToFileURL } from "node:url";
import { Refusal } from "../../refusal.ts";

const execution = new AsyncLocalStorage<string>();
// The execution context, rather than the loader's caller-selected base, owns
// this boundary. Builtins bypass file resolution; all other code is bundled.
Bun.plugin({
  name: "dori-adapter-execution",
  setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ path }) => {
      const entry = execution.getStore();
      if (entry && path !== entry && path !== pathToFileURL(entry).href)
        throw new Refusal("Runtime adapter dependencies must be bundled");
      return undefined;
    });
  },
});

export const executeAdapter = <T>(entry: string, operation: () => T): Promise<Awaited<T>> =>
  execution.run(entry, async (): Promise<Awaited<T>> => {
    try {
      return await operation();
    } catch (error) {
      let message: unknown;
      try {
        message = error instanceof Error ? error.message : String(error);
      } catch {
        // Even failure formatting can throw adapter-owned objects.
        throw new Refusal("Adapter failure could not be formatted");
      }
      throw new Refusal(typeof message === "string" ? message : "Adapter failure message must be text");
    }
  });
