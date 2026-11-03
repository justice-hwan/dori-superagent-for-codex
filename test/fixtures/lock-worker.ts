import { openSync, closeSync, unlinkSync } from "node:fs";
import { acquireFileLease } from "../../src/lock.ts";
const [lock, marker] = process.argv.slice(2) as [string, string];
const lease = acquireFileLease(lock);
if (lease) {
  const fd = openSync(marker, "wx"); closeSync(fd);
  await Bun.sleep(200);
  unlinkSync(marker); lease.release();
}
