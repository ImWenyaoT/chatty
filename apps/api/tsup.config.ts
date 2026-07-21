import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "application-factory": "src/application-factory.ts",
    "browser-smoke": "src/browser-smoke.ts",
    "http-application": "src/http-application.ts",
  },
  format: ["esm"],
  platform: "node",
  external: ["node:sqlite"],
  removeNodeProtocol: false,
  target: "node24",
  clean: true,
  noExternal: ["@chatty/contracts"],
});
