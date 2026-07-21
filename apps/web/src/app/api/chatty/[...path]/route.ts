import { basename, dirname, resolve } from 'node:path'

type RouteContext = {
  params: Promise<{ path: string[] }>
}

type HttpApplication = {
  handle(request: Request, pathname?: string): Promise<Response>
}

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

let applicationPromise: Promise<HttpApplication> | undefined

function repositoryRoot() {
  const cwd = process.cwd()
  return basename(cwd) === 'web' && basename(dirname(cwd)) === 'apps'
    ? resolve(cwd, '../..')
    : cwd
}

async function directApplication() {
  applicationPromise ??= (async () => {
    const root = repositoryRoot()
    const knowledgePath = resolve(root, 'knowledge/records.jsonl')
    const e2eDatabase = process.env.CHATTY_E2E_DATABASE
    if (e2eDatabase !== undefined) {
      const { createBrowserSmokeHttpApplication } =
        await import('@chatty/agent/browser-smoke')
      return createBrowserSmokeHttpApplication({
        databasePath: resolve(root, e2eDatabase),
        knowledgePath,
      })
    }
    const { createDefaultHttpApplication } =
      await import('@chatty/agent/application-factory')
    return createDefaultHttpApplication({
      databasePath:
        process.env.CHATTY_DATABASE_PATH ?? resolve(root, 'data/chatty.sqlite'),
      knowledgePath,
    })
  })()
  try {
    return await applicationPromise
  } catch (error) {
    applicationPromise = undefined
    throw error
  }
}

async function dispatch(request: Request, context: RouteContext) {
  const { path } = await context.params
  return (await directApplication()).handle(
    request,
    `/${path.map(encodeURIComponent).join('/')}`,
  )
}

export const DELETE = dispatch
export const GET = dispatch
export const HEAD = dispatch
export const OPTIONS = dispatch
export const PATCH = dispatch
export const POST = dispatch
export const PUT = dispatch
