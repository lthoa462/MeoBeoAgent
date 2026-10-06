import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { NextConfig } from 'next'

// One .env at the repository root serves the backend, the Teams bot and this
// app. `next dev|build|start` run with apps/web as the working directory.
// loadEnvFile never overrides variables that are already set.
const repoRoot = resolve(process.cwd(), '../..')
const rootEnv = resolve(repoRoot, '.env')
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv)

/** First non-empty value: `KEY=` in .env means "unset", not "empty string". */
function firstSet(...values: ReadonlyArray<string | undefined>): string | undefined {
  return values.map(value => value?.trim()).find(value => value !== undefined && value !== '')
}

// The SPA usually reuses the bot's Entra app registration, so CLIENT_ID and
// TENANT_ID are accepted as fallbacks. Next inlines these into the browser
// bundle; they are public identifiers, never secrets.
const publicEnv = Object.fromEntries(
  Object.entries({
    NEXT_PUBLIC_AZURE_CLIENT_ID: firstSet(process.env.NEXT_PUBLIC_AZURE_CLIENT_ID, process.env.CLIENT_ID),
    NEXT_PUBLIC_AZURE_TENANT_ID: firstSet(process.env.NEXT_PUBLIC_AZURE_TENANT_ID, process.env.TENANT_ID),
  }).filter((entry): entry is [string, string] => entry[1] !== undefined),
)

const config: NextConfig = {
  // The backend ships raw TypeScript (with explicit .ts imports), so Next
  // compiles it in the same pass as the app.
  transpilePackages: ['@meobeo/backend'],
  // The Teams SDK is Express-based and resolves optional modules at runtime;
  // bundling it breaks that, so it is required from node_modules instead.
  serverExternalPackages: [
    '@microsoft/teams.apps',
    '@microsoft/teams.api',
    '@microsoft/teams.cards',
    '@microsoft/teams.common',
    '@microsoft/teams.graph',
  ],
  env: publicEnv,
  // packages/backend lives outside apps/web; both bundlers need the monorepo
  // root to follow the workspace symlink and the hoisted node_modules.
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  poweredByHeader: false,
  reactStrictMode: true,
  // `next dev` would otherwise (re)write AGENTS.md/CLAUDE.md into apps/web.
  agentRules: false,
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        // Links in summaries come from untrusted chat content; never tell the
        // destination which page (or conversation) the click came from.
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        // Same-origin framing stays allowed: MSAL renews tokens in a hidden iframe.
        { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
      ],
    }]
  },
}

export default config
