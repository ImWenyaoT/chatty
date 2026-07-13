import { resolve } from "node:path";
import dotenv from "dotenv";
import { resolveChattyDatabasePath } from "../lib/database-path.mjs";

dotenv.config({
  path: resolve(import.meta.dirname, "../../../.env"),
  quiet: true,
});

if (!process.env.CHATTY_DB_PATH?.trim()) {
  process.env.CHATTY_DB_PATH = resolveChattyDatabasePath(
    undefined,
    resolve(import.meta.dirname, "../../.."),
  );
}

await import("../node_modules/next/dist/bin/next");
