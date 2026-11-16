import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { copyFileSync, constants, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { accountDeviceDescriptorSchema, type AccountDeviceDescriptor } from '@dsh-remote/protocol'
import { z } from 'zod'

export class ApiError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code) }
}
export const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
export const secret = (): string => randomBytes(32).toString('base64url')
export const equal = (left: string, right: string): boolean => timingSafeEqual(Buffer.from(hash(left)), Buffer.from(hash(right)))
const tokenSchema = z.object({
  kind: z.enum(['access', 'refresh']), deviceId: z.string(), expires: z.number(), used: z.boolean(),
  recovery: z.object({ nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/), accessExpires: z.number().int().positive() }).optional(),
})
const savedDeviceSchema = z.object({ ownerId: z.string(), descriptor: accountDeviceDescriptorSchema, revoked: z.boolean(), lastSeenAt: z.number() })
const userSchema = z.object({ account: z.string(), provider: z.enum(['legacy', 'xcodex']), grant: z.string().optional() })
const stateSchema = z.object({ version: z.literal(2), users: z.record(z.string(), userSchema), account: z.string(), salt: z.string(), verifier: z.string(), devices: z.record(z.string(), savedDeviceSchema), tokens: z.record(z.string(), tokenSchema) })
type SavedDevice = z.infer<typeof savedDeviceSchema>
type SavedToken = z.infer<typeof tokenSchema>

// Domain-separated HMACs keyed by the presented bearer, NOT its stored digest.
// The nonce alone cannot recover credentials from a copy of state.json.
function successor(token: string, nonce: string, deviceId: string) {
  const derive = (kind: string) => createHmac('sha256', token)
    .update(JSON.stringify(['ds-harness-remote/refresh/v1', deviceId, nonce, kind])).digest('base64url')
  return { accessToken: derive('access'), refreshToken: derive('refresh') }
}

/** Single-process store. Device token digests, public identities and encrypted upstream grants reach disk. */
export class Store {
  private state: z.infer<typeof stateSchema>
  onUserInvalidate: (id: string) => void = () => {}
  onInvalidate: (id: string) => void = () => {}
  readonly legacyUserId: string
  checkUser: (id: string) => void = () => {}
  constructor(private readonly file: string, readonly account: string, password: string) {
    this.legacyUserId = 'legacy:' + hash(account)
    let raw = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined
    if (raw?.version === 1) {
      const legacy = z.object({ version: z.literal(1), account: z.string(), salt: z.string(), verifier: z.string(), devices: z.record(z.string(), savedDeviceSchema.omit({ ownerId: true })), tokens: z.record(z.string(), tokenSchema) }).parse(raw)
      const ownerId = 'legacy:' + hash(legacy.account)
      // Exclusive backup before the first v2 write. Never overwrite a prior recovery copy.
      if (existsSync(file + '.v1-backup')) {
        if (!readFileSync(file).equals(readFileSync(file + '.v1-backup'))) throw Error('Migration backup differs; manual recovery required')
      } else copyFileSync(file, file + '.v1-backup', constants.COPYFILE_EXCL)
      raw = { ...legacy, version: 2, users: { [ownerId]: { account: legacy.account, provider: 'legacy' } }, devices: Object.fromEntries(Object.entries(legacy.devices).map(([id, d]) => [id, { ...d, ownerId }])) }
    }
    const previous = raw === undefined ? undefined : stateSchema.parse(raw)
    if (previous) for (const d of Object.values(previous.devices)) if (!Object.hasOwn(previous.users, d.ownerId)) throw new Error('Invalid device owner')
    const salt = previous?.salt ?? secret()
    const verifier = scryptSync(password, salt, 32).toString('hex')
    this.state = previous ?? { version: 2, users: {}, account, salt, verifier, devices: {}, tokens: {} }
    const oldOwner = 'legacy:' + hash(this.state.account)
    if (this.state.account !== account || !equal(this.state.verifier, verifier)) {
      for (const [key, token] of Object.entries(this.state.tokens)) if (this.state.devices[token.deviceId]?.ownerId === oldOwner) delete this.state.tokens[key]
    }
    if (this.state.account !== account) {
      for (const [id, device] of Object.entries(this.state.devices)) if (device.ownerId === oldOwner) delete this.state.devices[id]
      delete this.state.users[oldOwner]
    }
    this.state.users[this.legacyUserId] = { account, provider: 'legacy' }
    Object.assign(this.state, { account, verifier })
    this.save()
  }
  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 })
    renameSync(tmp, this.file)
  }
  get(id: string): SavedDevice {
    const d = Object.hasOwn(this.state.devices, id) ? this.state.devices[id] : undefined
    if (!d) throw new ApiError('DEVICE_NOT_FOUND', 404)
    if (d.revoked) throw new ApiError('DEVICE_REVOKED', 403)
    return d
  }
  user(id: string) {
    if (!Object.hasOwn(this.state.users, id)) throw new ApiError('AUTH_INVALID', 401)
    return this.state.users[id]!
  }
  users() { return Object.entries(this.state.users) }
  setUser(id: string, account: string, grant: string) {
    if (!id.startsWith('xcodex:')) throw new ApiError('AUTH_INVALID', 401)
    const previous = this.state.users[id]
    if (!previous && Object.keys(this.state.users).length >= 4096) throw new ApiError('RATE_LIMITED', 429)
    this.state.users[id] = { account, provider: 'xcodex', grant }
    try { this.save() } catch (e) { if (previous) this.state.users[id] = previous; else delete this.state.users[id]; throw e }
  }
  invalidateUser(id: string) {
    this.onUserInvalidate(id)
    for (const d of Object.values(this.state.devices)) if (d.ownerId === id) this.invalidate(d.descriptor.deviceId)
  }
  checkDevice(id: string) { const device = this.get(id); this.checkUser(device.ownerId); return device }
  owned(id: string, ownerId: string) {
    const d = Object.hasOwn(this.state.devices, id) ? this.state.devices[id] : undefined
    if (!d || d.ownerId !== ownerId) throw new ApiError('DEVICE_NOT_FOUND', 404)
    return this.get(id)
  }
  sameOwner(a: string, b: string) {
    const source = this.checkDevice(a), target = this.checkDevice(b)
    if (source.ownerId !== target.ownerId) throw new ApiError('MEMBERSHIP_REQUIRED', 403)
  }
  list(ownerId = this.legacyUserId): SavedDevice[] { return Object.values(this.state.devices).filter(d => !d.revoked && d.ownerId === ownerId) }
  register(descriptor: AccountDeviceDescriptor, ownerId = this.legacyUserId): ReturnType<Store['issue']> {
    this.user(ownerId)
    const old = this.state.devices[descriptor.deviceId]
    if (old && old.ownerId !== ownerId) throw new ApiError('DEVICE_NOT_FOUND', 404)
    if (old?.revoked) throw new ApiError('DEVICE_REVOKED', 403)
    if (old && (old.descriptor.identityKey !== descriptor.identityKey || old.descriptor.role !== descriptor.role)) throw new ApiError('PEER_IDENTITY_MISMATCH', 409)
    if (!old && (Object.keys(this.state.devices).length >= 4096 || this.list(ownerId).length >= 256)) throw new ApiError('RATE_LIMITED', 429)
    this.state.devices[descriptor.deviceId] = { ownerId, descriptor, revoked: false, lastSeenAt: old?.lastSeenAt ?? 0 }
    this.invalidate(descriptor.deviceId)
    return this.issue(descriptor.deviceId)
  }
  private issue(deviceId: string, refreshTokenExpiresAt = Date.now() + 30 * 86400_000, previous?: { token: string; record: SavedToken }) {
    const tokens = { ...this.state.tokens }
    for (const [key, value] of Object.entries(tokens)) if (value.expires <= Date.now()) delete tokens[key]
    if (Object.keys(tokens).length + 2 > 16384) throw new ApiError('RATE_LIMITED', 429)
    const accessTokenExpiresAt = Date.now() + 60 * 60_000
    const nonce = secret()
    const { accessToken, refreshToken } = previous
      ? successor(previous.token, nonce, deviceId)
      : { accessToken: secret(), refreshToken: secret() }
    if (previous) tokens[hash(previous.token)] = {
      ...previous.record, used: true, recovery: { nonce, accessExpires: accessTokenExpiresAt },
    }
    tokens[hash(accessToken)] = { kind: 'access', deviceId, expires: accessTokenExpiresAt, used: false }
    tokens[hash(refreshToken)] = { kind: 'refresh', deviceId, expires: refreshTokenExpiresAt, used: false }
    const before = this.state.tokens
    this.state.tokens = tokens
    // Commit consumption, recovery metadata and the successor together. A failed
    // write must leave the previous token usable both in memory and after restart.
    try { this.save() } catch (error) { this.state.tokens = before; throw error }
    return { accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt }
  }
  authenticate(token: string): SavedDevice {
    const record = this.state.tokens[hash(token)]
    if (!record || record.kind !== 'access') throw new ApiError('AUTH_INVALID', 401)
    if (record.expires <= Date.now()) throw new ApiError('TOKEN_EXPIRED', 401)
    return this.get(record.deviceId)
  }
  refreshOwner(deviceId: string, token: string) {
    const record = this.state.tokens[hash(token)]
    if (!record || record.kind !== 'refresh' || record.deviceId !== deviceId) throw new ApiError('AUTH_INVALID', 401)
    if (record.expires <= Date.now()) throw new ApiError('TOKEN_EXPIRED', 401)
    return this.get(deviceId).ownerId
  }
  refresh(deviceId: string, token: string) {
    this.get(deviceId)
    const record = this.state.tokens[hash(token)]
    if (!record || record.kind !== 'refresh' || record.deviceId !== deviceId) throw new ApiError('AUTH_INVALID', 401)
    if (record.expires <= Date.now()) throw new ApiError('TOKEN_EXPIRED', 401)
    if (!record.used) return this.issue(deviceId, record.expires, { token, record })
    // Legacy consumed tokens have no recovery record. Reject them without
    // invalidating credentials that may already be in use by this device.
    if (!record.recovery) throw new ApiError('AUTH_INVALID', 401)
    const pair = successor(token, record.recovery.nonce, deviceId)
    const next = this.state.tokens[hash(pair.refreshToken)]
    if (!next || next.kind !== 'refresh' || next.deviceId !== deviceId || next.expires !== record.expires) {
      throw new ApiError('INTERNAL_ERROR', 503)
    }
    if (next.used) throw new ApiError('AUTH_INVALID', 401)
    const access = this.state.tokens[hash(pair.accessToken)]
    if (access ? access.kind !== 'access' || access.deviceId !== deviceId || access.expires !== record.recovery.accessExpires
      : record.recovery.accessExpires > Date.now()) throw new ApiError('INTERNAL_ERROR', 503)
    // Return the original expiry, including an expired access bearer. The
    // recovered, still-valid refresh token can then rotate normally.
    return { ...pair, accessTokenExpiresAt: record.recovery.accessExpires, refreshTokenExpiresAt: next.expires }
  }
  invalidate(deviceId: string): void {
    for (const [key, value] of Object.entries(this.state.tokens)) if (value.deviceId === deviceId) delete this.state.tokens[key]
    this.onInvalidate(deviceId)
    this.save()
  }
  revoke(id: string): void { this.get(id).revoked = true; this.invalidate(id) }
  rename(id: string, name: string): void {
    this.get(id).descriptor.name = name
    this.save()
  }
  touch(id: string, clientVersion?: string, harnessVersion?: string): void {
    const d = this.get(id)
    d.lastSeenAt = Date.now()
    if (clientVersion) d.descriptor.clientVersion = clientVersion.slice(0, 64)
    if (d.descriptor.role === 'host' && harnessVersion) d.descriptor.harnessVersion = harnessVersion.slice(0, 64)
    this.save()
  }
}
