import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DeviceLogins } from '../src/device-login.js'
import { Store, secret } from '../src/store.js'
let dir: string, store: Store, flows: DeviceLogins, now: number
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'device-login-'))
  store = new Store(join(dir, 'state.json'), 'admin@example.com', 'test-password-long')
  now = Date.now(); flows = new DeviceLogins(store, 'https://remote.example', ['xcodex://auth/remote'], () => now)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))
function start(redirectUri?: string) {
  const codeVerifier = secret(), state = secret()
  const device = { deviceId: randomUUID(), role: 'host', identityKey: secret(), name: 'computer', platform: 'linux', clientVersion: '0.6.4' }
  const result = flows.start({ device, codeChallenge: createHash('sha256').update(codeVerifier).digest('base64url'), state, ...(redirectUri ? { redirectUri } : {}) })
  const browserToken = new URLSearchParams(new URL(result.loginUrl).hash.slice(1)).get('device_login')!
  return { ...result, codeVerifier, browserToken, device, state }
}
const ensure = async () => {}
function exchange(f: ReturnType<typeof start>) {
  const poll = flows.poll(f)
  return { requestId: f.requestId, pickupToken: f.pickupToken, code: poll.code, codeVerifier: f.codeVerifier }
}
it('binds a single device and identity, retries one issuance, and rejects mismatched proofs and revocation', async () => {
  const f = start('xcodex://auth/remote')
  expect(f.loginUrl).not.toContain(f.pickupToken)
  expect(flows.poll(f).status).toBe('pending')
  const done = flows.complete(f.browserToken, store.legacyUserId)
  const redirect = new URL(done.redirectUrl!)
  expect(redirect.searchParams.get('state')).toBe(f.state)
  expect(redirect.searchParams.get('requestId')).toBe(f.requestId)
  expect(flows.complete(f.browserToken, store.legacyUserId)).toEqual(done)
  expect(() => flows.complete(f.browserToken, 'other')).toThrow('DEVICE_LOGIN_CONFLICT')
  expect(store.list()).toHaveLength(0)
  const data = exchange(f)
  for (const patch of [{ codeVerifier: secret() }, { pickupToken: secret() }, { code: secret() }, { device: f.device }]) {
    await expect(flows.exchange({ ...data, ...patch }, ensure)).rejects.toThrow()
  }
  const results = await Promise.all([flows.exchange(data, ensure), flows.exchange(data, ensure)])
  expect(results[0]).toEqual(results[1]); expect(store.list()).toHaveLength(1)
  expect(store.authenticate(results[0]!.accessToken).descriptor.deviceId).toBe(f.device.deviceId)
  expect(() => flows.cancel(f)).toThrow('DEVICE_LOGIN_CONFLICT')
  store.revoke(f.device.deviceId)
  await expect(flows.exchange(data, ensure)).rejects.toThrow()
})
it('cancels and expires even while account verification is pending; restart drops pending authority', async () => {
  for (const action of ['cancel', 'expire'] as const) {
    const f = start(); flows.complete(f.browserToken, store.legacyUserId)
    let resume!: () => void
    const pending = flows.exchange(exchange(f), () => new Promise<void>(r => { resume = r }))
    if (action === 'cancel') flows.cancel(f); else now += 600001
    resume()
    await expect(pending).rejects.toThrow(action === 'cancel' ? 'DEVICE_LOGIN_CANCELLED' : 'DEVICE_LOGIN_EXPIRED')
    expect(flows.poll(f).status).toBe(action === 'cancel' ? 'cancelled' : 'expired')
  }
  expect(store.list()).toHaveLength(0)
  const f = start()
  const restarted = new DeviceLogins(store, 'https://remote.example')
  expect(() => restarted.poll(f)).toThrow('DEVICE_LOGIN_INVALID')
})
it('rejects unconfigured redirects and upstream disabled accounts; recovery is bounded', async () => {
  expect(() => start('https://attacker.example')).toThrow('DEVICE_LOGIN_REDIRECT_DENIED')
  const f = start(); flows.complete(f.browserToken, store.legacyUserId)
  await expect(flows.exchange(exchange(f), async () => { throw Error('ACCOUNT_DISABLED') })).rejects.toThrow('ACCOUNT_DISABLED')
  expect(store.list()).toHaveLength(0)
  await flows.exchange(exchange(f), ensure)
  now += 60001
  await expect(flows.exchange(exchange(f), ensure)).rejects.toThrow('DEVICE_LOGIN_EXPIRED')
})
