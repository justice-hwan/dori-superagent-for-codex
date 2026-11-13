import { request } from "node:http";
import { chmodSync, mkdirSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { Jobs } from "./jobs.ts";
import { Filter, Outcome, Principal, RequestInput } from "./schema.ts";
import { Store } from "./store.ts";

const config = await loadConfig();
process.umask(0o077);
mkdirSync(config.directory, { recursive: true, mode: 0o700 });
chmodSync(config.directory, 0o700);
const bytes = await Bun.stdin.bytes();
if (bytes.length > 32768) throw new RangeError("Outcome exceeds 32 KiB");
const input: unknown = JSON.parse(new TextDecoder().decode(bytes));
const store = new Store(config.database, config.instance);
try {
  switch (process.argv[2]) {
    case "submit": {
      const jobs = new Jobs(store, config.runtimeCommand, wakeBridge, config.outcomeCommand, config.configPath);
      const result = await jobs.submit(Principal.parse(config.localPrincipal), RequestInput.parse(input));
      console.log(JSON.stringify(result));
      break;
    }
    case "status":
      console.log(JSON.stringify(store.job(Principal.parse(config.localPrincipal), Filter.parse(input).job_id)));
      break;
    case "update": {
      const outcome = Outcome.parse(input);
      store.update(outcome);
      console.log(
        JSON.stringify({
          job_id: outcome.job_id,
          revision: outcome.revision,
          durable: true,
        }),
      );
      break;
    }
    default:
      throw new TypeError("Usage: bun cli.ts submit|status|update < input.json");
  }
} finally {
  store.close();
}
if (process.argv[2] !== "update" || !config.oauth) process.exit(0);
// Database write is durable even if the bridge is offline; restart resumes the outbox.
await wakeBridge();
function wakeBridge(): Promise<void> {
  if (!config.oauth) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const wake = request(
      {
        socketPath: config.socket,
        path: "/wake",
        method: "POST",
        timeout: 10000,
      },
      (response) => {
        response.resume();
        response.once("end", () =>
          response.statusCode === 200 ? resolve() : reject(new TypeError("Bridge wake failed")),
        );
      },
    );
    wake.once("timeout", () => wake.destroy(new TypeError("Bridge wake timed out")));
    wake.once("error", reject);
    wake.end();
  });
}
