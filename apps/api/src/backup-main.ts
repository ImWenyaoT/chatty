import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { backupDatabase } from "./backup.js";

const { values } = parseArgs({
  options: {
    database: { type: "string", default: "../../data/chatty.sqlite" },
    output: { type: "string" },
  },
});
if (!values.output) throw new Error("--output is required");
const database = resolve(values.database);
const output = resolve(values.output);
const pages = await backupDatabase(database, output);
console.log(JSON.stringify({ database, output, pages }));
