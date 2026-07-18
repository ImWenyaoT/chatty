// @ts-check

import js from "@eslint/js";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/.next/**",
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/*.svg",
      "**/.remember/**",
      "learn-chatty/**",
      "pnpm-lock.yaml",
    ],
  },
  {
    settings: {
      next: {
        rootDir: "apps/web/",
      },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...nextVitals,
  ...nextTs,
);
