// ============================================================
// run_log.ts
// Purpose : Persist raw run output in private, exclusive log files
// Feature : Shared
// Role    : Utility
// API Doc : N/A
// ============================================================
import { writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export interface RunLogInput {
  directory: string;
  fileName: string;
  content: string;
}

export async function writeRunLog({ directory, fileName, content }: RunLogInput): Promise<string> {
  if (!isAbsolute(directory)) {
    throw new Error("Run log directory must be absolute");
  }
  if (fileName.length === 0 || fileName === "." || fileName === ".." || /[\\/]/.test(fileName)) {
    throw new Error("Run log file name must be a simple leaf");
  }

  const path = join(directory, fileName);
  await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600, flush: true });
  return path;
}
