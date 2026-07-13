import path from "node:path";

export const DEFAULT_CHATTY_DATABASE_PATH = "data/chatty.sqlite";

/** Resolves an override or the canonical durable SQLite path. */
export function resolveChattyDatabasePath(configuredPath, rootDirectory) {
  const value = configuredPath?.trim();
  if (value === ":memory:") return value;
  return path.resolve(rootDirectory, value || DEFAULT_CHATTY_DATABASE_PATH);
}
