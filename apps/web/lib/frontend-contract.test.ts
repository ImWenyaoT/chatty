import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function readAppSource(path: string) {
  return readFileSync(resolve(appRoot, path), 'utf8')
}

const layoutSource = readAppSource('src/app/layout.tsx')
const homeSource = readAppSource('src/app/page.tsx')
const workbenchRouteSource = readAppSource('src/app/workbench/page.tsx')
const workbenchSource = readAppSource('src/features/WorkbenchPage.tsx')
const apiRouteSource = readAppSource('src/app/api/chatty/[...path]/route.ts')
const cssSource = readAppSource('src/globals.css')
const webPackage = JSON.parse(readAppSource('package.json')) as {
  dependencies?: Record<string, string>
  scripts?: Record<string, string>
}

test('Next.js exposes one Workbench product entry and safe legacy redirects', () => {
  assert.match(homeSource, /redirect\('\/workbench'\)/)
  assert.match(workbenchRouteSource, /WorkbenchPage/)
  for (const route of ['playground', 'orders', 'dashboard']) {
    assert.match(
      readAppSource(`src/app/${route}/page.tsx`),
      /redirect\('\/workbench'\)/,
    )
  }
  assert.ok(webPackage.dependencies?.next)
  assert.match(webPackage.scripts?.build ?? '', /next build/)
  for (const script of ['dev', 'start']) {
    assert.match(webPackage.scripts?.[script] ?? '', /node scripts\/next\.mjs/)
  }
  assert.match(
    readAppSource('scripts/next.mjs'),
    /process\.loadEnvFile\(rootEnv\)/,
  )
})

test('Workbench remains a thin, accessible Agent HTTP client', () => {
  assert.match(layoutSource, /lang="zh-CN"/)
  assert.match(layoutSource, /className="skip-link"/)
  assert.match(workbenchSource, /id="main-content"/)
  assert.match(workbenchSource, /<h1[\s\S]*Agent 内容工作台/)
  assert.match(workbenchSource, /<h2>/)
  assert.match(workbenchSource, /aria-live="polite"/)
  assert.match(workbenchSource, /aria-label="Artifacts"/)
  assert.match(workbenchSource, /requestJson/)
  assert.match(workbenchSource, /RunResponseSchema/)
  assert.match(workbenchSource, /ArtifactListSchema/)
  assert.match(workbenchSource, /ArtifactApprovalSchema/)
  assert.match(workbenchSource, /导出到 sandbox/)
  assert.doesNotMatch(
    workbenchSource,
    /xiaohongshu\.com|douyin\.com|weixin\.qq\.com|@openai\/agents|node:sqlite/,
  )
})

test('Next Route Handler owns no second Agent or persistence path', () => {
  assert.match(apiRouteSource, /@chatty\/agent\/application-factory/)
  assert.match(apiRouteSource, /export const runtime = 'nodejs'/)
  assert.match(apiRouteSource, /applicationPromise = undefined/)
  assert.doesNotMatch(apiRouteSource, /Fastify|better-sqlite3|Runner/)
})

test('global styles retain semantic tokens, focus, dark mode and touch targets', () => {
  assert.match(cssSource, /@theme inline/)
  assert.match(cssSource, /:focus-visible/)
  assert.match(cssSource, /\.skip-link/)
  assert.match(cssSource, /prefers-color-scheme: dark/)
  assert.match(cssSource, /min-height: 44px/)
})
