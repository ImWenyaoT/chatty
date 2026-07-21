import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { seedDemoData } from "./demo-data.js";

const { values } = parseArgs({
  options: {
    database: { type: "string", default: "../../data/chatty.sqlite" },
  },
});

console.log(JSON.stringify(seedDemoData(resolve(values.database))));
