import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const rootEnv = resolve(import.meta.dirname, '../../..', '.env')

if (existsSync(rootEnv)) process.loadEnvFile(rootEnv)

await import('next/dist/bin/next')
