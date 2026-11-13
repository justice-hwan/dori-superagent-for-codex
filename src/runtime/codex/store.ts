import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CreateSpec, DeliveryBatch, SessionRef } from "../types.ts";
import { array, CodexError, object, text } from "./protocol.ts";

export type RecordEntry = {
  readonly id: string;
  readonly spec: CreateSpec;
  readonly closed: boolean;
  readonly uncertain?: string;
  readonly confirmed?: DeliveryBatch;
  readonly desktopOwned?: boolean;
  readonly pid?: number;
  readonly birth?: string;
};
const ID = /^(?:worker-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CodexStore {
  readonly directory: string;
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
    this.directory = join(this.root, "codex", "sessions");
  }
  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }
  path(id: string): string {
    if (!ID.test(id)) throw new CodexError("ownership", "Invalid Codex session id");
    return join(this.directory, `${id}.json`);
  }
  async save(entry: RecordEntry): Promise<void> {
    await this.init();
    const path = this.path(entry.id);
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(entry), { mode: 0o600 });
    await rename(temporary, path);
  }
  async owned(ref: SessionRef, allowClosed = false): Promise<RecordEntry> {
    if (ref.runtime !== "codex") throw new CodexError("ownership", "Not a Codex ref");
    const file = Bun.file(this.path(ref.id));
    if (!(await file.exists())) throw new CodexError("ownership", `Codex session ${ref.id} is not owned by this home`);
    const data = object(await file.json());
    const spec = object(data["spec"]);
    const env = object(spec["env"]);
    const role = text(spec["role"]);
    const container = text(spec["container"]);
    if (
      !["lead", "duty", "lane", "duty-loop", "hourly-loop"].includes(role) ||
      !["workspace-root", "tab", "split-below"].includes(container) ||
      data["id"] !== ref.id ||
      typeof data["closed"] !== "boolean" ||
      Object.values(env).some((v) => typeof v !== "string")
    )
      throw new CodexError("ownership", "Invalid Codex ownership record");
    // CreateSpec is parsed explicitly below rather than trusting JSON as a runtime ref.
    const parsedRole =
      role === "lead" || role === "duty" || role === "lane" || role === "duty-loop" ? role : "hourly-loop";
    const parsedContainer = container === "tab" || container === "split-below" ? container : "workspace-root";
    const parsedEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) parsedEnv[key] = text(value);
    const entry: RecordEntry = {
      id: ref.id,
      closed: data["closed"],
      spec: {
        name: text(spec["name"]),
        cwd: text(spec["cwd"]),
        env: parsedEnv,
        role: parsedRole,
        container: parsedContainer,
        ...(typeof spec["group"] === "string" ? { group: spec["group"] } : {}),
      },
      ...(typeof data["uncertain"] === "string" ? { uncertain: data["uncertain"] } : {}),
      ...(data["confirmed"] === undefined
        ? {}
        : {
            confirmed: {
              id: text(object(data["confirmed"])["id"]),
              messageIds: array(object(data["confirmed"])["messageIds"]).map(text),
            },
          }),
      ...(typeof data["desktopOwned"] === "boolean" ? { desktopOwned: data["desktopOwned"] } : {}),
      ...(typeof data["pid"] === "number" ? { pid: data["pid"] } : {}),
      ...(typeof data["birth"] === "string" ? { birth: data["birth"] } : {}),
    };
    if (entry.closed && !allowClosed) throw new CodexError("ownership", "Codex session is closed");
    return entry;
  }
  async entries(): Promise<readonly RecordEntry[]> {
    await this.init();
    const names = await readdir(this.directory);
    const entries = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map((name) => this.owned({ runtime: "codex", id: name.slice(0, -5) }, true)),
    );
    return entries.filter((entry) => !entry.closed);
  }
}

export const reference = (entry: RecordEntry): SessionRef => ({
  runtime: "codex",
  id: entry.id,
  ...(entry.spec.group ? { group: entry.spec.group } : {}),
});
