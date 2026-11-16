import { array, type CodexConnection, CodexError, object, text } from "./protocol.ts";
import { disabledConfiguredMcpServers } from "./mcp-config.ts";

const MAX_ENTRIES = 16;
const MAX_TEXT = 96;
type Facet<T> = { readonly state: "value"; readonly value: T } | { readonly state: "null" | "missing" | "malformed" };
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const boundedText = (value: string) => ({
  value: value.slice(0, MAX_TEXT),
  length: value.length,
  truncated: value.length > MAX_TEXT,
  ...(value.length > MAX_TEXT ? { digest: new Bun.CryptoHasher("sha256").update(value).digest("hex") } : {}),
});
const namesOf = (names: Iterable<string>) => {
  const values: ReturnType<typeof boundedText>[] = [];
  let total = 0;
  for (const name of names) {
    total++;
    if (values.length < MAX_ENTRIES) values.push(boundedText(name));
  }
  return { total, values, omitted: total - values.length };
};
const facet = <T>(row: unknown, key: string, parse: (value: unknown) => T | undefined): Facet<T> => {
  if (!record(row)) return { state: "malformed" };
  if (!Object.hasOwn(row, key)) return { state: "missing" };
  if (row[key] === null) return { state: "null" };
  const value = parse(row[key]);
  return value === undefined ? { state: "malformed" } : { state: "value", value };
};
const textFacet = (value: unknown) => (typeof value === "string" ? boundedText(value) : undefined);
const runtimeFacet = (value: unknown) =>
  typeof value === "string" &&
  ["notStarted", "starting", "connected", "authenticationRequired", "failed", "cancelled", "disabled"].includes(value)
    ? value
    : undefined;
const objectCount = (value: unknown) => (record(value) ? Object.keys(value).length : undefined);
const arrayCount = (value: unknown) => (Array.isArray(value) ? value.length : undefined);
const statusOf = (row: unknown) => ({
  observation: "status" as const,
  name: facet(row, "name", textFacet),
  runtimeStatus: facet(row, "runtimeStatus", runtimeFacet),
  pluginId: facet(row, "pluginId", textFacet),
  tools: facet(row, "tools", objectCount),
  resources: facet(row, "resources", arrayCount),
  resourceTemplates: facet(row, "resourceTemplates", arrayCount),
});

/** Bounded observations only; none of these diagnostic fields grant registration authority. */
class Observations {
  private readonly preStart;
  private postConfig:
    | {
        readonly state: "observed";
        readonly total: number;
        readonly values: ReturnType<typeof boundedText>[];
        readonly omitted: number;
      }
    | { readonly state: "unavailable" } = { state: "unavailable" };
  private pages = 0;
  private rowsTotal = 0;
  private readonly rows: ReturnType<typeof statusOf>[] = [];
  private readonly pageShapes: Facet<number>[] = [];

  constructor(allowed: ReadonlySet<string>) {
    this.preStart = namesOf(allowed);
  }
  config(names: Iterable<string>) {
    this.postConfig = { state: "observed", ...namesOf(names) };
  }
  page(value: unknown) {
    this.pages++;
    const shape = facet(value, "data", arrayCount);
    if (this.pageShapes.length < MAX_ENTRIES) this.pageShapes.push(shape);
    const data = record(value) ? value["data"] : undefined;
    if (!Array.isArray(data)) return;
    this.rowsTotal += data.length;
    for (const row of data) if (this.rows.length < MAX_ENTRIES) this.rows.push(statusOf(row));
  }
  snapshot() {
    return {
      version: 1,
      preStart: this.preStart,
      postConfig: this.postConfig,
      status: {
        pages: this.pages,
        rowsTotal: this.rowsTotal,
        rows: [...this.rows],
        omittedRows: this.rowsTotal - this.rows.length,
        pageShapes: [...this.pageShapes],
        omittedPages: this.pages - this.pageShapes.length,
      },
    };
  }
}
const evidence = new WeakMap<Error, ReturnType<Observations["snapshot"]>>();
export const admissionEvidence = (error: unknown) => (error instanceof Error ? evidence.get(error) : undefined);

/** Preserve the existing name-membership decision; state facets are observations, never an allowlist. */
export const assertAdmittedMcpServers = async (
  connection: CodexConnection,
  cwd: string,
  threadId: string,
  allowed: ReadonlySet<string>,
  milliseconds: number,
): Promise<void> => {
  const observations = new Observations(allowed);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new CodexError("unsupported", "MCP admission check timed out")), milliseconds);
  });
  try {
    const names = await Promise.race([admittedNames(connection, cwd, threadId, observations), expired]);
    const unexpected = [...names].filter((name) => !allowed.has(name));
    if (unexpected.length) {
      const shown = namesOf(unexpected);
      throw new CodexError(
        "unsupported",
        `Thread admitted unexpected MCP servers: ${shown.values.map((name) => name.value).join(", ")}${shown.omitted ? ` (${shown.omitted} more omitted)` : ""}`,
      );
    }
  } catch (error) {
    if (error instanceof Error) {
      const details = observations.snapshot();
      evidence.set(error, details);
      Object.assign(error, { mcpAdmission: details });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

const admittedNames = async (
  connection: CodexConnection,
  cwd: string,
  threadId: string,
  observations: Observations,
) => {
  const names = new Set(Object.keys(await disabledConfiguredMcpServers(connection, cwd)));
  observations.config(names);
  let cursor: unknown = null;
  do {
    const response = await connection.call("mcpServerStatus/list", {
      threadId,
      ...(cursor === null ? {} : { cursor }),
    });
    observations.page(response);
    const page = object(response);
    for (const entry of array(page["data"])) names.add(text(object(entry)["name"]));
    cursor = page["nextCursor"] ?? null;
  } while (cursor !== null);
  return names;
};
