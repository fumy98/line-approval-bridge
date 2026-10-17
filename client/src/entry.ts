import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** True when this module is the process entry point (works through npm bin symlinks). */
export function isMain(moduleUrl: string): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
