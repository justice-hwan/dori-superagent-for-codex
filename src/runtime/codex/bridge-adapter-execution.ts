import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import Module, { createRequire, isBuiltin } from "node:module";
import { basename, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { SourceTextModule, SyntheticModule } from "node:vm";
import { Refusal } from "../../refusal.ts";
import { object } from "./protocol.ts";

const execution = new AsyncLocalStorage<string>();
const modules = new Map<string, Promise<unknown>>();
const builtins = new Map<string, Promise<SyntheticModule>>();
// Bun's file plugin skips bare names. CommonJS resolution must be checked
// before its cache, independently of the caller-selected createRequire base.
const resolveFilename: unknown = Reflect.get(Module, "_resolveFilename");
if (typeof resolveFilename !== "function") throw new Refusal("Runtime cannot enforce adapter resolution");
Reflect.set(Module, "_resolveFilename", function (this: unknown, ...args: unknown[]): unknown {
  if (execution.getStore() && (typeof args[0] !== "string" || !isBuiltin(args[0])))
    throw new Refusal("Runtime adapter dependencies must be bundled");
  return Reflect.apply(resolveFilename, this, args);
});

Bun.plugin({
  name: "dori-adapter-execution",
  setup(builder) {
    builder.onResolve({ filter: /.*/ }, () => {
      if (execution.getStore()) throw new Refusal("Runtime adapter dependencies must be bundled");
      return undefined;
    });
  },
});

const builtinModule = (specifier: string): Promise<SyntheticModule> => {
  if (!isBuiltin(specifier)) throw new Refusal("Runtime adapter dependencies must be bundled");
  const name = specifier.includes(":") || specifier === "bun" ? specifier : `node:${specifier}`;
  const cached = builtins.get(name);
  if (cached) return cached;
  const result = (async () => {
    const exports = object(await import(name));
    const module = new SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
      },
      { identifier: name },
    );
    await module.link(builtinModule);
    await module.evaluate();
    return module;
  })();
  builtins.set(name, result);
  return result;
};

/** Every ESM request uses this linker, including cached bare dynamic imports. */
export const importAdapter = (entry: string): Promise<unknown> => {
  const cached = modules.get(entry);
  if (cached) return cached;
  const result = executeAdapter(entry, async () => {
    const module = new SourceTextModule(readFileSync(entry, "utf8"), {
      identifier: pathToFileURL(entry).href,
      initializeImportMeta(meta) {
        Object.assign(meta, {
          url: pathToFileURL(entry).href,
          path: entry,
          filename: entry,
          dir: dirname(entry),
          dirname: dirname(entry),
          file: basename(entry),
          main: false,
          require: createRequire(entry),
          resolve: (specifier: string) => {
            if (!isBuiltin(specifier)) throw new Refusal("Runtime adapter dependencies must be bundled");
            return import.meta.resolve(specifier);
          },
        });
      },
      importModuleDynamically: builtinModule,
    });
    await module.link(builtinModule);
    if (module.hasTopLevelAwait()) throw new Refusal("Adapter initialization must be synchronous");
    await module.evaluate();
    return module.namespace;
  });
  modules.set(entry, result);
  return result;
};
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
