import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'
import globals from 'globals'

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ['app/**/*.{ts,tsx}', 'src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: ['lib/**/*.ts', '*.config.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },
  globalIgnores([
    '.next/**',
    'dist/**',
    'out/**',
    'node_modules/**',
    'next-env.d.ts',
  ]),
])
