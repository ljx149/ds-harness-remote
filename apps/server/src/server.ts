import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { z } from 'zod'
import { deviceRegistrationRequestSchema, deviceRefreshRequestSchema, parseWireJson } from '@dsh-remote/protocol'
import { ApiError, Store, equal, hash, secret } from './store.js'
import { IdentitySessions, XcodexProvider, type IdentityProvider } from './xcodex-auth.js'
import { DeviceLogins, ExchangeValidationError } from './device-login.js'
import { Gateway } from './gateway.js'
import { buildIceServers, parseIceConfig, type IceConfig } from './ice.js'
import { Logger, type LogLevel } from './logger.js'
import {
  FORCE_TERMINATE_GRACE_MS_RANGE,
  HEARTBEAT_DISCONNECT_MS_MAX,
  HELLO_TIMEOUT_MS_RANGE,
  HEARTBEAT_INTERVAL_MS_RANGE,
  MAX_FRAMES_PER_SEC_RANGE,
  normalizeForceTerminateGraceMs,
  normalizeGatewayOptions,
  normalizeHeartbeatDisconnectMs,
  normalizeHeartbeatIntervalMs,
  normalizeHelloTimeoutMs,
  normalizeMaxFramesPerSec,
} from './config.js'

export interface Config {
  account: string
  password: string
  dataFile: string
  publicUrl: string
  trustedProxyIps?: readonly string[]
  helloTimeoutMs?: number
  heartbeatIntervalMs?: number
  heartbeatDisconnectMs?: number
  forceTerminateGraceMs?: number
  maxFramesPerSec?: number
  logLevel?: LogLevel
  authMode?: 'local' | 'xcodex'
  xcodexCredentialKey?: string
  xcodexOrigin?: string
  xcodexSupabaseOrigin?: string
  identityProvider?: IdentityProvider
  deviceLoginRedirectUris?: readonly string[]
  allowLegacyLogin?: boolean
  ice?: IceConfig
}

/**
 * Timing configuration is normalized in one place (`config.ts`) so the CLI and
 * programmatic callers share the same bounds and fallbacks. These wrappers keep
 * the env-var parsing API used by `main.ts` and the tests, and never echo the
 * offending input in their warnings.
 */
export function parseHelloTimeout(val: string | undefined): number {
  return normalizeHelloTimeoutMs(val)
}

export function parseHeartbeatInterval(val: string | undefined): number {
  return normalizeHeartbeatIntervalMs(val)
}

export function parseHeartbeatDisconnect(val: string | undefined, heartbeatIntervalMs: number = HEARTBEAT_INTERVAL_MS_RANGE.fallback): number {
  return normalizeHeartbeatDisconnectMs(val, heartbeatIntervalMs)
}

export function parseForceTerminateGrace(val: string | undefined): number {
  return normalizeForceTerminateGraceMs(val)
}

export function parseMaxFramesPerSec(val: string | undefined): number {
  return normalizeMaxFramesPerSec(val)
}

export {
  normalizeGatewayOptions,
  normalizeHelloTimeoutMs,
  normalizeHeartbeatIntervalMs,
  normalizeHeartbeatDisconnectMs,
  normalizeForceTerminateGraceMs,
  normalizeMaxFramesPerSec,
  HELLO_TIMEOUT_MS_RANGE,
  HEARTBEAT_INTERVAL_MS_RANGE,
  HEARTBEAT_DISCONNECT_MS_MAX,
  FORCE_TERMINATE_GRACE_MS_RANGE,
  MAX_FRAMES_PER_SEC_RANGE,
}
export type { GatewayTimingOptions, NormalizedGatewayOptions } from './config.js'

const loginSchema = z.object({ email: z.string().min(1).max(254), password: z.string().min(1).max(1024) }).strict()
const publicDir = fileURLToPath(new URL('../dist/public/', import.meta.url))
function readAssets(): Map<string, Buffer> {
  if (!existsSync(publicDir)) return new Map()
  const assets = new Map<string, Buffer>()
  for (const entry of readdirSync(publicDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const file = join(entry.parentPath, entry.name)
    const path = file.slice(publicDir.length).replaceAll('\\', '/')
    assets.set(path, readFileSync(file))
  }
  return assets
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new ApiError('INVALID_MESSAGE', 415)
  let length = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    length += chunk.length
    if (length > 16384) throw new ApiError('FRAME_TOO_LARGE', 413)
    chunks.push(chunk)
  }
  try { return parseWireJson(Buffer.concat(chunks)) } catch { throw new ApiError('INVALID_MESSAGE') }
}
/**
 * Normalize one bare IPv4/IPv6 literal to a single canonical form. IPv4-mapped
 * IPv6 addresses (e.g. ::ffff:127.0.0.1) collapse to plain IPv4, so a peer
 * observed through a dual-stack socket and a config entry compare equal.
 * Returns null for anything that is not a single IP literal: hostnames, ports,
 * CIDR ranges, comma-separated lists, bracketed hosts and zone identifiers.
 */
export function normalizeIp(value: string): string | null {
  const family = isIP(value)
  if (family === 4) return value.toLowerCase()
  if (family !== 6) return null
  let canonical: string
  try {
    canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1)
  } catch { return null }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical)
  if (!mapped) return canonical
  const high = Number.parseInt(mapped[1]!, 16), low = Number.parseInt(mapped[2]!, 16)
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`
}
/** Validate and normalize the trusted proxy list at startup. Empty means disabled. */
export function normalizeTrustedProxyIps(values: readonly string[] = []): ReadonlySet<string> {
  const result = new Set<string>()
  for (const raw of values) {
    const value = raw.trim()
    const normalized = value === '' ? null : normalizeIp(value)
    if (normalized === null) throw new Error(`Invalid DSH_SERVER_TRUSTED_PROXY_IPS entry "${raw}": expected a bare IPv4/IPv6 address (no port, CIDR or hostname).`)
    result.add(normalized)
  }
  return result
}
function readSingleForwardedFor(req: IncomingMessage): string {
  let value: string | undefined
  let count = 0
  const raw = req.rawHeaders
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (raw[i]!.toLowerCase() !== 'x-forwarded-for') continue
    count++
    value = raw[i + 1]
  }
  if (count !== 1) throw new ApiError('INVALID_MESSAGE')
  return value!
}
/**
 * Resolve the address used for rate limiting. X-Forwarded-For is honored only
 * when the socket peer is a configured trusted proxy; that peer must send one
 * header holding exactly one IP literal, otherwise the request is rejected.
 */
export function clientAddress(req: IncomingMessage, trustedProxyIps: ReadonlySet<string>): string {
  const peer = normalizeIp(req.socket.remoteAddress ?? '')
  if (peer === null) throw new ApiError('INVALID_MESSAGE')
  if (!trustedProxyIps.has(peer)) return peer
  const forwarded = normalizeIp(readSingleForwardedFor(req))
  if (forwarded === null) throw new ApiError('INVALID_MESSAGE')
  return forwarded
}
export function createRemoteServer(config: Config) {
  if (!config.account.trim() || config.password.length < 12) throw new Error('DSH_SERVER_ACCOUNT and DSH_SERVER_PASSWORD (at least 12 characters) are required.')
  const url = new URL(config.publicUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('DSH_SERVER_PUBLIC_URL must be an HTTP(S) origin.')
  const trustedProxyIps = normalizeTrustedProxyIps(config.trustedProxyIps)
  const ice = config.ice ?? parseIceConfig({})
  if (config.authMode === 'xcodex' && !/^[a-f0-9]{64}$/i.test(config.xcodexCredentialKey ?? '')) throw new Error('DSH_XCODEX_CREDENTIAL_KEY must be 32 bytes encoded as hex')
  const store = new Store(config.dataFile, config.account.trim(), config.password)
  const assets = readAssets()
  const provider = config.identityProvider ?? new XcodexProvider(config.xcodexOrigin ?? 'https://xcodex.vip', config.xcodexSupabaseOrigin ?? 'https://ahsurstleqvxlfxmawor.supabase.co')
  const identities = config.authMode === 'xcodex' ? new IdentitySessions(store, provider, config.xcodexCredentialKey ?? '') : undefined
  if (!identities && store.users().some(([, u]) => u.provider === 'xcodex')) throw new Error('External identities require xcodex mode; restore the pre-migration backup to roll back')
  const deviceLogins = new DeviceLogins(store, url.origin, config.deviceLoginRedirectUris)
  const sessions = new Map<string, { userId: string; expires: number }>()
  store.onUserInvalidate = id => { for (const [key, session] of sessions) if (session.userId === id) sessions.delete(key) }
  const limits = new Map<string, { count: number; until: number }>()
  function rate(key: string, max: number) {
    for (const [k, v] of limits) if (v.until < Date.now()) limits.delete(k)
    let entry = limits.get(key)
    if (!entry) { if (limits.size >= 4096) throw new ApiError('RATE_LIMITED', 429); entry = { count: 0, until: Date.now() + 60_000 }; limits.set(key, entry) }
    if (++entry.count > max) throw new ApiError('RATE_LIMITED', 429)
  }
  function token(req: IncomingMessage): string {
    const authorization = req.headers.authorization
    if (authorization) return authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
    return /(?:^|;\s*)dsh_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '')?.[1] ?? ''
  }
  async function accountAuth(req: IncomingMessage) {
    const key = hash(token(req)), session = sessions.get(key)
    if (!session || session.expires <= Date.now()) { sessions.delete(key); throw new ApiError('ACCOUNT_AUTH_REQUIRED', 401) }
    await identities?.ensure(session.userId)
    if (sessions.get(key) !== session) throw new ApiError('ACCOUNT_AUTH_REQUIRED', 401)
    return session.userId
  }
  async function deviceAuth(req: IncomingMessage) {
    if (!req.headers.authorization?.startsWith('Bearer ')) throw new ApiError('AUTH_REQUIRED', 401)
    const bearer = req.headers.authorization.slice(7), device = store.authenticate(bearer)
    await identities?.ensure(device.ownerId)
    return store.authenticate(bearer)
  }
  function cookie(value: string, age: number): string { return `dsh_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${url.protocol === 'https:' ? '; Secure' : ''}` }
  const profile = (userId: string) => ({ userId, account: store.user(userId).account, profile: { displayName: store.user(userId).account }, isAdmin: false })
  const oauthFlows = new Map<string, { verifier: string; expires: number; deviceLogin?: string }>()
  const callbackPath = '/api/v1/auth/supabase/callback'
  function flowCookie(value: string, age: number) { return `dsh_oauth=${value}; Path=${callbackPath}; HttpOnly; SameSite=Lax; Max-Age=${age}${url.protocol === 'https:' ? '; Secure' : ''}` }
  function issueSession(userId: string) {
    for (const [key, session] of sessions) if (session.expires <= Date.now()) sessions.delete(key)
    if (sessions.size >= 256) throw new ApiError('RATE_LIMITED', 429)
    const value = secret(), expiresAt = Date.now() + 8 * 3600_000
    sessions.set(hash(value), { userId, expires: expiresAt })
    return { ...profile(userId), token: value, expiresAt }
  }
  const server = createServer({ requestTimeout: 15000, headersTimeout: 10000 }, (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
    void route(req, res).catch(error => {
      if (res.headersSent || res.destroyed) return
      const e = error instanceof ApiError ? error : error instanceof z.ZodError ? new ApiError('INVALID_MESSAGE') : new ApiError('INTERNAL_ERROR', 500)
      if (e.status === 429) res.setHeader('Retry-After', '60')
      const requestId = randomUUID()
      const details = error instanceof ExchangeValidationError ? { failures: error.failures } : undefined
      if (req.method === 'POST' && req.url?.split('?')[0] === '/api/v1/auth/device/exchange' && e.status === 400) {
        logger.warn('device_exchange_rejected', { requestId, errorCode: e.code, httpStatus: e.status,
          stage: details ? 'request_schema' : 'request_or_business_validation', ...(details ?? {}) })
      }
      json(res, e.status, { error: { code: e.code, message: e.code, requestId,
        retryable: e.status === 429 || e.status >= 500, ...(details ? { details } : {}) } })
    })
  })
  const logger = new Logger('server', config.logLevel ?? 'info')
  // Normalize at this boundary as well: a programmatic caller may pass NaN,
  // Infinity or a negative value straight through the Config object.
  const timing = normalizeGatewayOptions({
    helloTimeoutMs: config.helloTimeoutMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    heartbeatDisconnectMs: config.heartbeatDisconnectMs,
    forceTerminateGraceMs: config.forceTerminateGraceMs,
  })
  const gateway = new Gateway(server, store, url.origin, {
    ...timing,
    maxFramesPerSec: normalizeMaxFramesPerSec(config.maxFramesPerSec),
    logLevel: config.logLevel,
    logger: logger.child('gateway'),
    turnEnabled: ice.turnUrls.length > 0,
  })
  function descriptor(d: ReturnType<Store['get']>) {
    return { ...d.descriptor, membershipId: `account:${d.ownerId === store.legacyUserId ? hash(store.account).slice(0, 16) : hash(d.ownerId).slice(0, 32)}`, online: gateway.peers.has(d.descriptor.deviceId), lastSeenAt: d.lastSeenAt }
  }
  async function route(req: IncomingMessage, res: ServerResponse) {
    const requestUrl = new URL(req.url ?? '/', url)
    const path = requestUrl.pathname
    const method = req.method
    const staticAsset = path.startsWith('/assets/') || ['/icon.png', '/xcodex-mark.svg', '/brand-whale.webp', '/landing-atmosphere.webp'].includes(path)
    const spaRoute = method === 'GET' && !staticAsset && !path.startsWith('/api/') && !path.startsWith('/ws/') && !['/health', '/healthz', '/ready'].includes(path)
    // A cross-site OAuth redirect chain stays cross-site through the final document.
    // Public HTML/assets contain no account data; protected APIs retain both checks.
    const publicGet = method === 'GET' && (spaRoute || staticAsset || path === callbackPath)
    if (!publicGet && req.headers.origin && req.headers.origin !== url.origin) throw new ApiError('AUTH_INVALID', 403)
    if (!publicGet && req.headers['sec-fetch-site'] === 'cross-site') throw new ApiError('AUTH_INVALID', 403)
    if (method === 'GET' && path === callbackPath) {
      rate(`oauth-callback:${clientAddress(req, trustedProxyIps)}`, 30)
      // Only the initiating browser can redeem a single-use, server-held PKCE flow.
      const state = requestUrl.searchParams.get('remote_state') ?? ''
      const browserState = /(?:^|;\s*)dsh_oauth=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '')?.[1] ?? ''
      const flow = oauthFlows.get(hash(state))
      let destination = '/app/remote'
      try {
        if (!identities || !provider.oauthExchange || !state || !equal(state, browserState) || !flow || flow.expires <= Date.now()) throw new ApiError('AUTH_FLOW_EXPIRED', 401)
        oauthFlows.delete(hash(state))
        const code = requestUrl.searchParams.get('code')
        if (requestUrl.searchParams.has('error') || !code || code.length > 4096) throw new ApiError('AUTH_CANCELLED', 401)
        if (flow.deviceLogin) deviceLogins.browser(flow.deviceLogin)
        const grant = await provider.oauthExchange(code, flow.verifier)
        const session = issueSession(identities.accept(grant))
        if (flow.deviceLogin) destination = '/app/login#device_login=' + encodeURIComponent(flow.deviceLogin)
        res.setHeader('Set-Cookie', [cookie(session.token, 8 * 3600), flowCookie('', 0)])
      } catch (error) {
        const code = error instanceof ApiError ? error.code : 'AUTH_SERVICE_UNAVAILABLE'
        destination = '/app/login?auth_error=' + encodeURIComponent(code) + (flow?.deviceLogin ? '#device_login=' + encodeURIComponent(flow.deviceLogin) : '')
        res.setHeader('Set-Cookie', flowCookie('', 0))
      }
      res.writeHead(303, { Location: destination }); res.end(); return
    }
    if (method === 'GET' && (spaRoute || staticAsset)) {
      const name = staticAsset ? path.slice(1) : 'index.html'
      const asset = assets.get(name)
      if (!asset) throw new ApiError('METHOD_NOT_FOUND', 404)
      const contentType = name.endsWith('.tgz') ? 'application/gzip' : name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : name.endsWith('.svg') ? 'image/svg+xml' : name.endsWith('.png') ? 'image/png' : name.endsWith('.webp') ? 'image/webp' : 'text/html; charset=utf-8'
      if (!staticAsset) res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Content-Type', contentType)
      res.end(asset); return
    }
    if (method === 'GET' && (path === '/health' || path === '/healthz' || path === '/ready')) { json(res, 200, { status: 'ok' }); return }
    const client = clientAddress(req, trustedProxyIps)
    rate(`api:${client}`, 240)
    if (method === 'POST' && path.startsWith('/api/v1/auth/device/')) {
      const action = path.slice('/api/v1/auth/device/'.length)
      if (action === 'complete' && req.headers.origin !== url.origin) throw new ApiError('AUTH_INVALID', 403)
      if (action === 'start') rate(`device-start:${client}`, 10)
      const data = await body(req)
      let result: unknown
      if (action === 'start') result = deviceLogins.start(data)
      else if (action === 'poll') result = deviceLogins.poll(data)
      else if (action === 'cancel') result = deviceLogins.cancel(data)
      else if (action === 'exchange') result = await deviceLogins.exchange(data, async id => { await identities?.ensure(id) })
      else if (action === 'complete') {
        const { browserToken } = z.object({ browserToken: z.string() }).strict().parse(data)
        result = deviceLogins.complete(browserToken, await accountAuth(req))
      } else throw new ApiError('METHOD_NOT_FOUND', 404)
      json(res, 200, result); return
    }
    if (method === 'GET' && path === '/api/v1/auth/methods') {
      json(res, 200, { mode: identities ? 'supabase' : 'local', google: !!identities && !!provider.oauthUrl, emailCode: !!identities && !!provider.sendOtp }); return
    }
    if (method === 'POST' && path.startsWith('/api/v1/auth/supabase/')) {
      if (!identities) throw new ApiError('METHOD_NOT_FOUND', 404)
      // Browser-only BFF endpoints: reject login CSRF, including requests with no Origin.
      if (req.headers.origin !== url.origin) throw new ApiError('AUTH_INVALID', 403)
      rate(`login:${client}`, 20)
      if (path === '/api/v1/auth/supabase/google' && provider.oauthUrl) {
        for (const [key, flow] of oauthFlows) if (flow.expires <= Date.now()) oauthFlows.delete(key)
        if (oauthFlows.size >= 256) throw new ApiError('RATE_LIMITED', 429)
        const { deviceLogin } = z.object({ deviceLogin: z.string().optional() }).parse(await body(req))
        if (deviceLogin) deviceLogins.browser(deviceLogin)
        const state = secret(), verifier = secret()
        const challenge = createHash('sha256').update(verifier).digest('base64url')
        const redirectTo = url.origin + callbackPath + '?remote_state=' + encodeURIComponent(state)
        const destination = await provider.oauthUrl(redirectTo, challenge)
        oauthFlows.set(hash(state), { verifier, expires: Date.now() + 600000, deviceLogin })
        res.setHeader('Set-Cookie', flowCookie(state, 600))
        json(res, 200, { url: destination }); return
      }
      if (path === '/api/v1/auth/supabase/otp/send' && provider.sendOtp) {
        const { email } = z.object({ email: z.string().trim().email().max(254) }).parse(await body(req))
        rate(`otp:${hash(email.toLowerCase())}`, 1)
        await provider.sendOtp(email.toLowerCase())
        json(res, 200, { status: 'sent' }); return
      }
      let userId: string
      if (path === '/api/v1/auth/supabase/otp/verify' && provider.verifyOtp) {
        const data = z.object({ email: z.string().trim().email().max(254), code: z.string().regex(/^\d{6,8}$/) }).parse(await body(req))
        userId = identities.accept(await provider.verifyOtp(data.email.toLowerCase(), data.code))
      } else if (path === '/api/v1/auth/supabase/password' && provider.passwordLogin) {
        const data = loginSchema.parse(await body(req))
        userId = identities.accept(await provider.passwordLogin(data.email.trim().toLowerCase(), data.password))
      } else throw new ApiError('METHOD_NOT_FOUND', 404)
      const session = issueSession(userId)
      res.setHeader('Set-Cookie', cookie(session.token, 8 * 3600))
      json(res, 200, session); return
    }
    if (method === 'POST' && (path === '/api/v1/auth/login' || path === '/api/v1/auth/account/password' || path === '/api/v1/auth/legacy/login' && config.allowLegacyLogin)) {
      rate(`login:${client}`, 20)
      const credentials = loginSchema.parse(await body(req))
      let userId: string
      if (identities && provider?.passwordLogin && path === '/api/v1/auth/account/password') {
        userId = identities.accept(await provider.passwordLogin(credentials.email.trim().toLowerCase(), credentials.password))
      } else if (identities && path !== '/api/v1/auth/legacy/login') userId = await identities.login(credentials.email.trim().toLowerCase(), credentials.password)
      else {
        if (!equal(credentials.email.trim(), store.account) || !equal(credentials.password, config.password)) throw new ApiError('AUTH_INVALID', 401)
        userId = store.legacyUserId
      }
      const session = issueSession(userId)
      res.setHeader('Set-Cookie', cookie(session.token, 8 * 3600))
      json(res, 200, session); return
    }
    if (method === 'GET' && path === '/api/v1/auth/me') { const userId = await accountAuth(req); json(res, 200, profile(userId)); return }
    if (method === 'POST' && path === '/api/v1/auth/logout') {
      sessions.delete(hash(token(req))); res.setHeader('Set-Cookie', cookie('', 0)); json(res, 200, { status: 'ok' }); return
    }
    if (method === 'GET' && path === '/api/v1/account/devices') {
      const userId = await accountAuth(req); json(res, 200, { items: store.list(userId).map(descriptor), serverUrl: url.origin, transport: 'webrtc' }); return
    }
    if (method === 'POST' && (path === '/api/v1/devices/register' || path === '/api/v1/devices/register-owned-role')) {
      const source = path.endsWith('register-owned-role') ? await deviceAuth(req) : undefined
      const ownerId = source ? source.ownerId : await accountAuth(req)
      const { device } = deviceRegistrationRequestSchema.parse(await body(req))
      if (source && (source.descriptor.deviceId === device.deviceId || source.descriptor.role === device.role)) throw new ApiError('INVALID_MESSAGE', 409)
      json(res, 200, store.register(device, ownerId)); return
    }
    if (method === 'POST' && path === '/api/v1/auth/refresh') {
      const data = deviceRefreshRequestSchema.parse(await body(req))
      const ownerId = store.refreshOwner(data.deviceId, data.refreshToken)
      await identities?.ensure(ownerId)
      json(res, 200, store.refresh(data.deviceId, data.refreshToken)); return
    }
    if (method === 'DELETE' && path === '/api/v1/devices/self') {
      store.revoke(store.authenticate(token(req)).descriptor.deviceId); json(res, 200, { status: 'revoked' }); return
    }
    if (method === 'GET' && path === '/api/v1/me') { json(res, 200, descriptor(await deviceAuth(req))); return }
    if (method === 'GET' && path === '/api/v1/turn/credentials') {
      const source = await deviceAuth(req)
      const connectionId = requestUrl.searchParams.get('connection_id') ?? ''
      if (!connectionId || connectionId.length > 128) throw new ApiError('INVALID_MESSAGE')
      if (!gateway.authorizeIce(source.descriptor.deviceId, connectionId)) throw new ApiError('CONNECTION_NOT_FOUND', 404)
      json(res, 200, { iceServers: buildIceServers(ice, source.descriptor.deviceId) }); return
    }
    if (method === 'GET' && path === '/api/v1/devices') {
      const source = await deviceAuth(req)
      if (source.descriptor.role !== 'client') throw new ApiError('MEMBERSHIP_REQUIRED', 403)
      const items = store.list(source.ownerId).filter(d => d.descriptor.role === 'host').map(d => {
        const { identityKey: _key, ...item } = descriptor(d)
        return item
      })
      json(res, 200, { items, nextCursor: null }); return
    }
    const renameMatch = /^\/api\/v1\/devices\/([^/]+)\/name$/.exec(path)
    if (method === 'POST' && renameMatch) {
      const ownerId = await accountAuth(req)
      store.owned(renameMatch[1]!, ownerId)
      const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(await body(req))
      store.rename(renameMatch[1]!, name)
      json(res, 200, descriptor(store.get(renameMatch[1]!))); return
    }
    const match = /^\/api\/v1\/devices\/([^/]+)(\/presence)?$/.exec(path)
    if (method === 'GET' && match) {
      const source = await deviceAuth(req), target = store.owned(match[1]!, source.ownerId)
      if (source.descriptor.role === target.descriptor.role) throw new ApiError('MEMBERSHIP_REQUIRED', 403)
      const d = descriptor(target)
      json(res, 200, match[2] ? { deviceId: d.deviceId, online: d.online, lastSeenAt: d.lastSeenAt } : d); return
    }
    throw new ApiError('METHOD_NOT_FOUND', 404)
  }
  return { server, store, gateway, logger, close: async () => { identities?.close(); gateway.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) } }
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value))
}
