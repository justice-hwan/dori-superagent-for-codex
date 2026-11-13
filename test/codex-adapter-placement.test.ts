import { expect, onTestFinished, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { adapterDescriptors } from "../src/runtime/codex/bridge-adapter.ts";
import { fixture } from "./codex-fixture.test.ts";

const setup = async () => {
  const f = await fixture();
  const trusted = mkdtempSync(join(homedir(), ".dori-adapter-placement-"));
  onTestFinished(() => rmSync(trusted, { recursive: true, force: true }));
  const module = join(trusted, "adapter.ts");
  const configPath = join(trusted, "config.json");
  writeFileSync(configPath, "{}");
  writeFileSync(
    join(f.root, "config.json"),
    JSON.stringify({
      codexBridgeAdapter: { module, configPath, instance: "personal" },
    }),
  );
  const scope = {
    root: realpathSync(f.root),
    cwd: realpathSync(f.spec.cwd),
    role: "lead" as const,
    key: "",
    id: "",
  };
  const source = readFileSync(new URL("./fixtures/bridge-adapter.ts", import.meta.url), "utf8");
  return { f, trusted, module, scope, source };
};

test.each([
  "direct",
  "symlink-package",
  "opaque-import",
  "opaque-require",
  "create-require",
  "create-require-forged-base",
  "create-require-symlink",
] as const)(
  "tool discovery refuses %s adapter dependencies before executing them, without an admitted job",
  async (mode) => {
    const { f, trusted, module, scope, source } = await setup();
    const marker = join(trusted, "executed");
    const payload = join(f.spec.cwd, "payload.ts");
    writeFileSync(
      payload,
      `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "escaped");`,
    );
    let load = `import ${JSON.stringify(payload)};`;
    if (mode === "symlink-package") {
      const dependency = join(f.spec.cwd, "dependency");
      mkdirSync(dependency);
      writeFileSync(
        join(dependency, "package.json"),
        JSON.stringify({ name: "fixture-dependency", exports: "./index.ts" }),
      );
      writeFileSync(join(dependency, "index.ts"), readFileSync(payload));
      mkdirSync(join(trusted, "node_modules"));
      symlinkSync(dependency, join(trusted, "node_modules/fixture-dependency"), "dir");
      load = 'import "fixture-dependency";';
    }
    if (mode === "opaque-import") load = `await import(${JSON.stringify(payload)}.slice(0));`;
    if (mode === "opaque-require") load = `require(${JSON.stringify(payload)}.slice(0));`;
    if (mode.startsWith("create-require")) {
      const base =
        mode === "create-require-forged-base" ? JSON.stringify(join(trusted, "other.ts")) : "import.meta.url";
      let target = payload;
      if (mode === "create-require-symlink") {
        target = join(trusted, "runtime-alias.ts");
        symlinkSync(payload, target);
      }
      load = `import {createRequire} from "node:module"; const load = createRequire(${base}); load(${JSON.stringify(target)});`;
    }
    writeFileSync(module, `${load}\n${source}`);

    const discovery = adapterDescriptors(scope);
    if (mode.startsWith("create-require"))
      await expect(discovery).rejects.toThrow("Runtime adapter dependencies must be bundled");
    else await expect(discovery).rejects.toThrow();
    expect(existsSync(marker)).toBe(false);
  },
);

test("tool discovery bundles protected dependencies and builtins without binding a job or opening the adapter", async () => {
  const { trusted, module, scope, source } = await setup();
  const helper = join(trusted, "helper.ts");
  const marker = join(trusted, "protected-helper-executed");
  writeFileSync(
    helper,
    `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "protected");`,
  );
  writeFileSync(module, `import "./helper.ts";\n${source}`);

  const tools = await adapterDescriptors(scope);
  expect(tools.map((tool) => tool["name"])).toEqual(["dori_job_status", "dori_report_outcome"]);
  expect(readFileSync(marker, "utf8")).toBe("protected");
});

test("adapter discovery refuses asynchronous module initialization before loading workspace code", async () => {
  const { f, trusted, module, scope, source } = await setup();
  const marker = join(trusted, "async-executed");
  const payload = join(f.spec.cwd, "async-payload.ts");
  writeFileSync(payload, `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "escaped");`);
  writeFileSync(
    module,
    `import {createRequire} from "node:module";
await Promise.resolve();
createRequire(import.meta.url)(${JSON.stringify(payload)});
${source}`,
  );

  await expect(adapterDescriptors(scope)).rejects.toThrow();
  expect(existsSync(marker)).toBe(false);
});

test("descriptor serialization cannot load workspace code outside the adapter policy", async () => {
  const { f, trusted, module, scope, source } = await setup();
  const marker = join(trusted, "descriptor-executed");
  const payload = join(f.spec.cwd, "descriptor-payload.ts");
  writeFileSync(payload, `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "escaped");`);
  writeFileSync(
    module,
    `${source}
import {createRequire} from "node:module";
const load = createRequire(import.meta.url);
Object.defineProperty(leadTools[0], "description", {enumerable:true, get() {
  load(${JSON.stringify(payload)}); return "unreachable";
}});`,
  );
  const discover = async () => JSON.stringify(await adapterDescriptors(scope));

  await expect(discover()).rejects.toThrow("Runtime adapter dependencies must be bundled");
  expect(existsSync(marker)).toBe(false);
});
