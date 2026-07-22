import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function readAppSource(path: string) {
  return readFileSync(resolve(appRoot, path), 'utf8')
}

const appSource = readAppSource('src/App.tsx')
const mainSource = readAppSource('src/main.tsx')
const indexHtmlSource = readAppSource('index.html')
const workbenchSource = readAppSource('src/features/WorkbenchPage.tsx')
const viteConfigSource = readAppSource('vite.config.ts')
const cssSource = readAppSource('src/globals.css')
const webPackage = JSON.parse(readAppSource('package.json')) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  scripts?: Record<string, string>
}

test('Vite exposes one Workbench product entry and safe legacy redirects', () => {
  assert.match(mainSource, /window\.location\.replace\('\/workbench'\)/)
  assert.match(appSource, /WorkbenchPage/)
  assert.match(mainSource, /LEGACY_PATHS/)
  for (const route of ['/playground', '/orders', '/dashboard']) {
    assert.match(mainSource, new RegExp(`'${route}'`))
  }
  assert.equal(webPackage.dependencies?.next, undefined)
  assert.equal(webPackage.devDependencies?.['eslint-config-next'], undefined)
  assert.ok(webPackage.devDependencies?.vite)
  for (const script of ['dev', 'build', 'start']) {
    assert.match(webPackage.scripts?.[script] ?? '', /vite/)
  }
  assert.match(viteConfigSource, /process\.env\.CHATTY_API_TARGET/)
})

test('Workbench remains a thin, accessible Agent HTTP client', () => {
  assert.match(indexHtmlSource, /lang="zh-CN"/)
  assert.match(appSource, /className="skip-link"/)
  assert.match(appSource, /href="#main-content"/)
  assert.match(workbenchSource, /id="main-content"/)
  assert.match(workbenchSource, /<h1[\s\S]*Agent 内容工作台/)
  assert.match(workbenchSource, /<h2>/)
  assert.match(workbenchSource, /aria-live="polite"/)
  assert.match(workbenchSource, /aria-label="Artifacts"/)
  assert.match(workbenchSource, /requestJson/)
  assert.match(workbenchSource, /RunResponseSchema/)
  assert.match(workbenchSource, /ArtifactListSchema/)
  assert.match(workbenchSource, /ArtifactApprovalSchema/)
  assert.match(workbenchSource, /@\/lib\/contracts/)
  assert.match(workbenchSource, /导出到 sandbox/)
  assert.doesNotMatch(
    workbenchSource,
    /xiaohongshu\.com|douyin\.com|weixin\.qq\.com|@openai\/agents|node:sqlite/,
  )
})

test('browser calls FastAPI through the same-origin Vite proxy', () => {
  assert.match(viteConfigSource, /'\/api\/chatty'/)
  assert.match(viteConfigSource, /process\.env\.CHATTY_API_TARGET/)
  assert.match(viteConfigSource, /'http:\/\/127\.0\.0\.1:8000'/)
  assert.match(viteConfigSource, /target: chattyApiTarget/)
  // 裁决（decisions.md §1.6）：代理原样透传 /api/chatty，禁止任何前缀改写。
  assert.doesNotMatch(viteConfigSource, /rewrite/)
  assert.match(viteConfigSource, /strictPort: true/)
  assert.equal(viteConfigSource.match(/proxy: chattyApiProxy/g)?.length, 2)
  assert.doesNotMatch(workbenchSource, /@chatty\/agent|application-factory/)
})

test('global styles retain semantic tokens, focus, dark mode and touch targets', () => {
  assert.match(cssSource, /@theme inline/)
  assert.match(cssSource, /:focus-visible/)
  assert.match(cssSource, /\.skip-link/)
  assert.match(cssSource, /prefers-color-scheme: dark/)
  assert.match(cssSource, /min-height: 44px/)
})
