export type SqliteRow = Record<string, string | number | bigint | null>;

export function text(row: SqliteRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`invalid SQLite text: ${key}`);
  return value;
}

export function integer(row: SqliteRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new Error(`invalid SQLite integer: ${key}`);
  }
  return Number(value);
}

export function nullableText(row: SqliteRow, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`invalid SQLite text: ${key}`);
  return value;
}
