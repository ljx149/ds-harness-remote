import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createRemoteServer } from '../src/server.js'
import type { IdentityGrant, IdentityProvider } from '../src/xcodex-auth.js'
const origin = 'https://remote.example'
const grant: IdentityGrant = { issuer: 'https://xcodex.example', subject: randomUUID(), email: 'alice@example.com', provider: 'supabase', token: 'private-upstream-access', refreshToken: 'private-upstream-refresh', expiresAt: Date.now() + 3600000 }
let app: ReturnType<typeof createRemoteServer>, base: string, dir: string
const provider: IdentityProvider = {
  login: vi.fn(async () => grant), verify: async value => value,
  oauthUrl: vi.fn(async (redirect, challenge) => `https://identity.example/authorize?redirect_to=${encodeURIComponent(redirect)}&code_challenge=${challenge}`),
  oauthExchange: vi.fn(async () => grant), sendOtp: vi.fn(async () => {}), verifyOtp: vi.fn(async () => grant), passwordLogin: vi.fn(async () => grant),
}
beforeEach(async () => {
  vi.clearAllMocks()
  dir = mkdtempSync(join(tmpdir(), 'remote-browser-'))
  app = createRemoteServer({ account: 'admin@example.com', password: 'legacy-password', dataFile: join(dir, 'state.json'), publicUrl: origin, authMode: 'xcodex', xcodexCredentialKey: 'a'.repeat(64), identityProvider: provider, logLevel: 'silent' })
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening')
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`
})
afterEach(async () => { vi.restoreAllMocks(); await app.close(); rmSync(dir, { recursive: true, force: true }) })
function post(path: string, body: unknown, headers: Record<string, string> = { Origin: origin }) {
  return fetch(base + '/api/v1/auth/supabase/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), redirect: 'manual' })
}
async function begin() {
  const r = await post('google', { return_to: 'https://attacker.example' }); expect(r.status).toBe(200)
  const url = new URL((await r.json()).url), callback = new URL(url.searchParams.get('redirect_to')!)
  return { callback, url, cookie: r.headers.get('set-cookie')!.split(';')[0]! }
}
it('binds Google PKCE to the browser, consumes the code once and issues only Remote credentials', async () => {
  const { callback, url, cookie } = await begin()
  expect(callback.origin).toBe(origin)
  expect(callback.pathname).toBe('/api/v1/auth/supabase/callback')
  const path = callback.pathname + callback.search + '&code=opaque-auth-code'
  const missing = await fetch(base + path, { redirect: 'manual' })
  expect(missing.headers.get('location')).toContain('AUTH_FLOW_EXPIRED')
  expect(provider.oauthExchange).not.toHaveBeenCalled()
  const r = await fetch(base + path, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' }, redirect: 'manual' })
  expect(r.status).toBe(303); expect(r.headers.get('location')).toBe('/app/remote')
  const document = await fetch(base + '/app/remote', { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' } })
  expect(document.status).toBe(200); expect(document.headers.get('content-type')).toContain('text/html')
  const [code, verifier] = vi.mocked(provider.oauthExchange!).mock.calls[0]!
  expect(code).toBe('opaque-auth-code')
  expect(createHash('sha256').update(verifier).digest('base64url')).toBe(url.searchParams.get('code_challenge'))
  const sessionCookie = r.headers.getSetCookie().find(value => value.startsWith('dsh_session='))!
  expect(sessionCookie).toContain('HttpOnly'); expect(sessionCookie).toContain('Secure')
  expect(sessionCookie).not.toContain(grant.token)
  const me = await fetch(base + '/api/v1/auth/me', { headers: { Cookie: sessionCookie.split(';')[0]! } })
  expect(me.status).toBe(200); expect((await me.json()).account).toBe(grant.email)
  const replay = await fetch(base + path, { headers: { Cookie: cookie }, redirect: 'manual' })
  expect(replay.headers.get('location')).toContain('AUTH_FLOW_EXPIRED'); expect(provider.oauthExchange).toHaveBeenCalledTimes(1)
})
it('rejects expired and cancelled flows without trusting error text or redirect targets', async () => {
  const { callback, cookie } = await begin()
  const r = await fetch(base + callback.pathname + callback.search + '&error=denied&error_description=secret', { headers: { Cookie: cookie }, redirect: 'manual' })
  expect(r.headers.get('location')).toBe('/app/login?auth_error=AUTH_CANCELLED')
  expect(provider.oauthExchange).not.toHaveBeenCalled()
  const next = await begin(), now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now + 601000)
  const expired = await fetch(base + next.callback.pathname + next.callback.search + '&code=unused', { headers: { Cookie: next.cookie }, redirect: 'manual' })
  expect(expired.headers.get('location')).toContain('AUTH_FLOW_EXPIRED')
})
it('rejects browser login CSRF and rate limits email delivery without calling the provider', async () => {
  for (const path of ['google', 'otp/send', 'otp/verify', 'password']) {
    expect((await post(path, {}, {})).status).toBe(403)
    expect((await post(path, {}, { Origin: 'https://attacker.example' })).status).toBe(403)
  }
  expect(provider.oauthUrl).not.toHaveBeenCalled(); expect(provider.sendOtp).not.toHaveBeenCalled()
  expect((await post('otp/send', { email: 'alice@example.com' })).status).toBe(200)
  expect((await post('otp/send', { email: 'ALICE@example.com' })).status).toBe(429)
  expect(provider.sendOtp).toHaveBeenCalledTimes(1)
})
it.each(['otp/verify', 'password'])('exchanges %s through verified provider identity and never returns upstream credentials', async path => {
  const r = await post(path, { email: 'alice@example.com', ...(path === 'password' ? { password: 'test-password' } : { code: '123456' }) })
  expect(r.status).toBe(200)
  const body = await r.json(); expect(body.account).toBe(grant.email); expect(body.userId).toMatch(/^xcodex:/)
  expect(JSON.stringify(body)).not.toContain(grant.token); expect(JSON.stringify(body)).not.toContain(grant.refreshToken!)
  const me = await fetch(base + '/api/v1/auth/me', { headers: { Authorization: 'Bearer ' + body.token } })
  expect(me.status).toBe(200)
})

it('allows public documents across OAuth redirects but retains cross-site API and login CSRF rejection', async () => {
  const headers = { Origin: 'https://accounts.google.com', 'Sec-Fetch-Site': 'cross-site' }
  for (const path of ['/app/login?auth_error=AUTH_CANCELLED', '/app/remote']) {
    expect((await fetch(base + path, { headers })).status).toBe(200)
  }
  for (const path of ['/api/v1/auth/me', '/api/v1/account/devices', '/api/v1/devices']) {
    expect((await fetch(base + path, { headers })).status).toBe(403)
  }
  expect((await post('google', {}, headers)).status).toBe(403)
  const callback = await fetch(base + '/api/v1/auth/supabase/callback?remote_state=forged&code=forged', { headers, redirect: 'manual' })
  expect(callback.headers.get('location')).toContain('AUTH_FLOW_EXPIRED')
  expect(provider.oauthExchange).not.toHaveBeenCalled()
})

it('preserves a device request through Google and requires a same-origin authenticated completion', async () => {
  const device = { deviceId: randomUUID(), role: 'host', name: 'computer', platform: 'linux', clientVersion: '0.6.4', identityKey: Buffer.alloc(32, 1).toString('base64url') }
  const r = await fetch(base + '/api/v1/auth/device/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device, state: 's'.repeat(43), codeChallenge: 'c'.repeat(43) }) })
  expect(r.status).toBe(200)
  const flow = await r.json(), browserToken = new URLSearchParams(new URL(flow.loginUrl).hash.slice(1)).get('device_login')
  const begin = await post('google', { deviceLogin: browserToken })
  const redirect = new URL(new URL((await begin.json()).url).searchParams.get('redirect_to')!)
  const callback = await fetch(base + redirect.pathname + redirect.search + '&code=test-code', { headers: { Cookie: begin.headers.get('set-cookie')!.split(';')[0]!, 'Sec-Fetch-Site': 'cross-site' }, redirect: 'manual' })
  expect(callback.headers.get('location')).toBe('/app/login#device_login=' + browserToken)
  const cookie = callback.headers.getSetCookie().find(v => v.startsWith('dsh_session='))!.split(';')[0]!
  for (const headers of [{}, { Origin: 'https://attacker.example', Cookie: cookie }, { Origin: origin }, { Origin: origin, Cookie: cookie }]) {
    const completion = await fetch(base + '/api/v1/auth/device/complete', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ browserToken }) })
    expect(completion.status).toBe(!('Origin' in headers) || headers.Origin !== origin ? 403 : !('Cookie' in headers) ? 401 : 200)
  }
  expect(app.store.list()).toHaveLength(0)
})

it('native password login uses the same provider as web and rejects cross-origin callers', async () => {
  const request = (headers: Record<string, string> = {}) => fetch(base + '/api/v1/auth/account/password', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ email: 'ALICE@example.com', password: 'test-password' }),
  })
  expect((await request({ Origin: 'https://attacker.example' })).status).toBe(403)
  expect(provider.passwordLogin).not.toHaveBeenCalled()
  const response = await request()
  expect(response.status).toBe(200)
  const value = await response.json()
  expect(value.account).toBe(grant.email)
  expect(value.userId).toMatch(/^xcodex:/)
  expect(provider.passwordLogin).toHaveBeenCalledWith('alice@example.com', 'test-password')
  expect(provider.login).not.toHaveBeenCalled()
  expect(JSON.stringify(value)).not.toContain(grant.token)
  expect(JSON.stringify(value)).not.toContain(grant.refreshToken!)
})

it('returns safe exchange validation details with the same request id as its diagnostic event', async () => {
  const { Logger } = await import('../src/logger.js')
  const warning = vi.spyOn(Logger.prototype, 'warn')
  const privateVerifier = 's'.repeat(64)
  const response = await fetch(base + '/api/v1/auth/device/exchange', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: 'r'.repeat(43), pickupToken: 'p'.repeat(43), code: 'c'.repeat(43), codeVerifier: privateVerifier, state: 'private-state' }),
  })
  expect(response.status).toBe(400)
  const result = await response.json()
  expect(result.error.code).toBe('INVALID_MESSAGE')
  expect(result.error.details.failures).toEqual([
    { field: 'codeVerifier', actualType: 'string', length: 64, reason: 'invalid_length' },
    { field: 'state', actualType: 'string', length: 13, reason: 'unrecognized_field' },
  ])
  expect(warning).toHaveBeenCalledWith('device_exchange_rejected', expect.objectContaining({
    requestId: result.error.requestId, errorCode: 'INVALID_MESSAGE', stage: 'request_schema', failures: result.error.details.failures,
  }))
  expect(JSON.stringify(result)).not.toContain(privateVerifier)
  expect(JSON.stringify(warning.mock.calls)).not.toContain(privateVerifier)
  expect(JSON.stringify(warning.mock.calls)).not.toContain('private-state')
})
