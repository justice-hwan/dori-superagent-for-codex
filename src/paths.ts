import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Stable identity before and after creation, including macOS /var and /private/var aliases. */
export function stateHome(home: string): string {
  const absolute = resolve(home);
  try { return realpathSync(absolute); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return join(stateHome(parent), basename(absolute));
  }
}
