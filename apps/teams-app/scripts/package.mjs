#!/usr/bin/env node
/**
 * Builds the Teams app package to sideload:
 *
 *   apps/teams-app/build/manifest.json
 *   apps/teams-app/build/meobeo-teams.zip   (manifest.json, color.png, outline.png at the root)
 *
 * Values come from the environment, then the repository's .env (which never
 * overrides what is already set):
 *   CLIENT_ID          required: the Entra app id, also the bot id
 *   WEB_URL            required (or BOT_DOMAIN): public https origin of this app
 *   TEAMS_APP_ID       optional: Teams app GUID; otherwise one is generated once
 *                      and kept in build/.app-id so re-uploads update the same app
 *   TEAMS_APP_VERSION  optional: manifest version; defaults to the root package.json version
 *
 * Only node built-ins are used: the ZIP is written by hand (deflate-raw +
 * CRC-32 from node:zlib), so packaging needs no dependency.
 *
 *   npm run teams:package
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateRawSync } from 'node:zlib'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(appDir, '../..')
const buildDir = resolve(appDir, 'build')
const appIdFile = resolve(buildDir, '.app-id')
const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const ICONS = [['color.png', 192], ['outline.png', 32]]

class UsageError extends Error {}

function main() {
  const envFile = resolve(repoRoot, '.env')
  if (existsSync(envFile)) process.loadEnvFile(envFile)

  const clientId = setting('CLIENT_ID')
  if (clientId === undefined || !GUID.test(clientId)) {
    throw new UsageError([
      clientId === undefined ? 'Thiếu CLIENT_ID.' : `CLIENT_ID "${clientId}" không phải GUID.`,
      'Đặt CLIENT_ID (Application (client) ID của app Entra, cũng là bot id) trong .env ở thư mục gốc,',
      'ví dụ bằng `teams app create --name MeoBeo --endpoint https://<tunnel>/api/messages --env .env`. Xem README.',
    ].join('\n'))
  }
  const webUrl = publicUrl()
  const host = new URL(webUrl).hostname
  const appId = teamsAppId()
  const version = setting('TEAMS_APP_VERSION') ?? rootVersion()

  const template = readFileSync(resolve(appDir, 'manifest.template.json'), 'utf8')
  const values = { CLIENT_ID: clientId, TEAMS_APP_ID: appId, WEB_URL: webUrl, WEB_HOSTNAME: host, APP_VERSION: version }
  const text = template.replace(/\{\{([A-Z_]+)\}\}/g, (placeholder, name) => {
    if (!(name in values)) throw new UsageError(`manifest.template.json dùng ${placeholder} nhưng script không có giá trị cho nó.`)
    // Values land inside JSON strings, so escape them as JSON.
    return JSON.stringify(values[name]).slice(1, -1)
  })
  const manifest = JSON.parse(text)
  checkManifest(manifest)

  const files = [['manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)]]
  for (const [name, size] of ICONS) files.push([name, readIcon(name, size)])

  mkdirSync(buildDir, { recursive: true })
  writeFileSync(resolve(buildDir, 'manifest.json'), files[0][1])
  const zipPath = resolve(buildDir, 'meobeo-teams.zip')
  writeFileSync(zipPath, zip(files))

  console.log([
    `Đã tạo ${relative(process.cwd(), zipPath)}`,
    `  Teams app id : ${appId}`,
    `  Bot id       : ${clientId}`,
    `  Web URL      : ${webUrl}`,
    `  Phiên bản    : ${version}`,
    '',
    'Tiếp theo: Teams → Apps → Manage your apps → Upload an app → Upload a custom app,',
    'rồi thêm MeoBeo vào một group chat hoặc team. Khi cập nhật manifest, tăng TEAMS_APP_VERSION.',
  ].join('\n'))
}

/** `KEY=` in .env means "not set", not an empty value. */
function setting(name) {
  const value = process.env[name]?.trim()
  return value === undefined || value === '' ? undefined : value
}

/** WEB_URL, or https://BOT_DOMAIN; normalized to origin + path without a trailing slash. */
function publicUrl() {
  const domain = setting('BOT_DOMAIN')
  const raw = setting('WEB_URL') ?? (domain === undefined ? undefined : `https://${domain.replace(/^https?:\/\//i, '')}`)
  if (raw === undefined) {
    throw new UsageError([
      'Thiếu WEB_URL (hoặc BOT_DOMAIN).',
      'Đặt WEB_URL là địa chỉ https công khai của app, ví dụ địa chỉ devtunnel: WEB_URL=https://abc123-3000.asse.devtunnels.ms',
    ].join('\n'))
  }
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new UsageError(`WEB_URL "${raw}" không phải URL hợp lệ (cần dạng https://ten-mien).`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UsageError(`WEB_URL "${raw}" phải bắt đầu bằng https://.`)
  if (url.protocol === 'http:' || url.hostname === 'localhost') {
    // Still packaged: the manifest is valid, but Teams cannot reach a bot there.
    console.warn('Cảnh báo: WEB_URL nên là địa chỉ https công khai (ví dụ devtunnel); Teams không gọi được localhost/http.')
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

/** TEAMS_APP_ID, else the id kept in build/.app-id, else a new one saved there. */
function teamsAppId() {
  const configured = setting('TEAMS_APP_ID')
  if (configured !== undefined) {
    if (!GUID.test(configured)) throw new UsageError(`TEAMS_APP_ID "${configured}" không phải GUID.`)
    return configured
  }
  if (existsSync(appIdFile)) {
    const kept = readFileSync(appIdFile, 'utf8').trim()
    if (GUID.test(kept)) return kept
  }
  const created = randomUUID()
  mkdirSync(buildDir, { recursive: true })
  writeFileSync(appIdFile, `${created}\n`)
  return created
}

function rootVersion() {
  const { version } = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'))
  return typeof version === 'string' && version !== '' ? version : '1.0.0'
}

/** Catch template mistakes before Teams does; the full schema is in `$schema`. */
function checkManifest(manifest) {
  const problems = []
  for (const key of ['manifestVersion', 'version', 'id', 'developer', 'name', 'description', 'icons', 'accentColor']) {
    if (manifest[key] === undefined) problems.push(`thiếu "${key}"`)
  }
  for (const [path, value] of [['id', manifest.id], ['bots[0].botId', manifest.bots?.[0]?.botId], ['webApplicationInfo.id', manifest.webApplicationInfo?.id]]) {
    if (typeof value !== 'string' || !GUID.test(value)) problems.push(`${path} phải là GUID`)
  }
  if ((manifest.name?.short ?? '').length > 30) problems.push('name.short dài quá 30 ký tự')
  if ((manifest.description?.short ?? '').length > 80) problems.push('description.short dài quá 80 ký tự')
  if ((manifest.description?.full ?? '').length > 4000) problems.push('description.full dài quá 4000 ký tự')
  if (!/^\d+\.\d+\.\d+/.test(manifest.version ?? '')) problems.push(`version "${manifest.version}" phải theo semver (ví dụ 1.0.0)`)
  if (problems.length > 0) throw new UsageError(`Manifest không hợp lệ: ${problems.join('; ')}.`)
}

/** Teams rejects icons of the wrong size, so read the PNG header instead of trusting the file name. */
function readIcon(name, size) {
  const path = resolve(appDir, name)
  if (!existsSync(path)) throw new UsageError(`Thiếu ${name}. Chạy: node apps/teams-app/scripts/make-icons.mjs`)
  const png = readFileSync(path)
  const isPng = png.length > 24 && png.readUInt32BE(0) === 0x89504e47 && png.toString('ascii', 12, 16) === 'IHDR'
  if (!isPng || png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size) {
    throw new UsageError(`${name} phải là PNG ${size}×${size}. Chạy lại: node apps/teams-app/scripts/make-icons.mjs`)
  }
  return png
}

// --- minimal ZIP writer -----------------------------------------------------

/**
 * Local file headers + data, then the central directory and the end record.
 * Each entry is deflated unless that does not make it smaller (PNGs are
 * already compressed). No ZIP64, no data descriptors: entries are tiny.
 */
function zip(entries) {
  const { time, date } = dosDateTime(new Date())
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, 'utf8')
    const deflated = deflateRawSync(data, { level: 9 })
    const stored = deflated.length >= data.length
    const body = stored ? data : deflated
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed: 2.0 (deflate)
    local.writeUInt16LE(0, 6) // flags: none (names are ASCII)
    local.writeUInt16LE(stored ? 0 : 8, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28) // extra field length
    locals.push(local, nameBytes, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4) // made by: Unix, spec 2.0 (so the mode below is honored)
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(stored ? 0 : 8, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    // extra length, comment length, disk number and internal attributes stay 0
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38) // regular file, rw-r--r--
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)

    offset += local.length + nameBytes.length + body.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8) // entries on this disk
  end.writeUInt16LE(entries.length, 10) // entries in total
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

/** MS-DOS timestamp (local time, 2-second resolution) used by ZIP headers. */
function dosDateTime(at) {
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2),
    date: ((Math.max(at.getFullYear(), 1980) - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  }
}

try {
  main()
} catch (error) {
  if (!(error instanceof UsageError)) throw error
  console.error(`teams:package: ${error.message}`)
  process.exitCode = 1
}
