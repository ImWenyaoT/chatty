import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

export async function backupDatabase(
  sourcePath: string,
  outputPath: string,
): Promise<number> {
  const source = resolve(sourcePath);
  const output = resolve(outputPath);
  if (source === output)
    throw new Error("backup output must differ from source");
  mkdirSync(dirname(output), { recursive: true });
  const database = new DatabaseSync(source);
  try {
    return await backup(database, output);
  } finally {
    database.close();
  }
}
