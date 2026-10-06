/**
 * Standalone server for the API and the Teams bot, without Next.js:
 *
 *   npm run serve              (from the repo root or packages/backend)
 *   PORT=3978 tsx src/serve.ts
 *
 * Reads the repository's root .env (variables already set in the environment
 * win). Logs URLs and modes only, never secrets or request content.
 */

import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { createApiApp } from './http/app.ts'
import { closeServices, getServices } from './services.ts'

const DEFAULT_PORT = 3978
/** SSE responses keep connections open; past this, shutdown stops waiting for them. */
const SHUTDOWN_GRACE_MS = 10_000

loadEnv()

const port = parsePort(process.env.PORT) ?? DEFAULT_PORT
const services = await getServices()
const app = createApiApp()

const server = serve({ fetch: app.fetch, port }, info => {
  const base = `http://localhost:${info.port}/api`
  const { config, llmProblem } = services
  console.log(`[meobeo] API: ${base}/health · ${base}/sources · ${base}/chat`)
  console.log(`[meobeo] LLM: ${config.llm.provider}${services.llm === undefined ? ` (chưa sẵn sàng: ${llmProblem ?? 'không rõ lý do'})` : ` · ${services.llm.model}`}`)
  if (config.demoMode) console.log('[meobeo] DEMO_MODE: dữ liệu demo, không cần đăng nhập Microsoft')
  console.log(config.teams.enabled
    ? `[meobeo] Bot Teams: ${base}/messages`
    : '[meobeo] Bot Teams: tắt (cần CLIENT_ID và CLIENT_SECRET)')
})

let stopping = false
async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  console.log(`[meobeo] ${signal}: đang dừng…`)
  const force = setTimeout(() => {
    // Streaming clients that never hang up must not block the exit.
    if ('closeAllConnections' in server) server.closeAllConnections()
  }, SHUTDOWN_GRACE_MS)
  force.unref()
  await Promise.allSettled([
    new Promise<void>(done => server.close(() => done())),
    // Aborts running turns, so open SSE streams end with an error frame and close.
    closeServices(),
  ])
  clearTimeout(force)
  process.exit(0)
}
process.once('SIGINT', () => { void shutdown('SIGINT') })
process.once('SIGTERM', () => { void shutdown('SIGTERM') })

/** The root .env, whether started from the repo root (npm -w) or from packages/backend. */
function loadEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [resolve(here, '../../../.env'), resolve(process.cwd(), '.env')]
  for (const file of new Set(candidates)) {
    // loadEnvFile never overrides variables that are already set, so the first file wins per key.
    if (existsSync(file)) process.loadEnvFile(file)
  }
}

function parsePort(value: string | undefined): number | undefined {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined
}
