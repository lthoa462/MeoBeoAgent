/**
 * Every `/api/*` request (web UI and the Teams bot's /api/messages) is
 * forwarded to the backend's Hono app. The Next.js layer keeps no request
 * logic of its own.
 */

import type { ApiAppOptions } from '@meobeo/backend'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Streaming responses must not be buffered by the route handler.
export const fetchCache = 'force-no-store'

type ApiApp = ReturnType<typeof import('@meobeo/backend').createApiApp>

const options: ApiAppOptions = { basePath: '/api' }

// Created on the first request, never at import: `next build` loads this
// module to read the exports above, and must not start the backend (config,
// LLM runtime, Teams SDK) while doing so.
let pending: Promise<ApiApp> | undefined

function api(): Promise<ApiApp> {
  pending ??= import('@meobeo/backend')
    .then(backend => backend.createApiApp(options))
    .catch((error: unknown) => {
      // Let the next request try again instead of caching the failure.
      pending = undefined
      throw error
    })
  return pending
}

async function handler(request: Request): Promise<Response> {
  let app: ApiApp
  try {
    app = await api()
  } catch (error) {
    // Only the error's own message: requests carry tokens and chat content.
    console.error('[meobeo] backend failed to start:', error instanceof Error ? error.message : String(error))
    return Response.json(
      { error: 'backend_unavailable', message: 'Máy chủ chưa khởi động được. Xem log của server.' },
      { status: 500 },
    )
  }
  return app.fetch(request)
}

export { handler as GET, handler as POST }
