import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { ApiError, hash, type Store } from './store.js'

const grantSchema = z.object({
  issuer: z.string(), subject: z.string().uuid(), email: z.string().email(),
  provider: z.enum(['local', 'supabase']), token: z.string().min(1).max(16384),
  refreshToken: z.string().min(1).max(16384).optional(), expiresAt: z.number().finite(),
})
export type IdentityGrant = z.infer<typeof grantSchema>
export interface IdentityProvider {
  login(email: string, password: string): Promise<IdentityGrant>
  verify(grant: IdentityGrant, checkpoint?: (grant: IdentityGrant) => void): Promise<IdentityGrant>
  oauthUrl?(redirectTo: string, challenge: string): Promise<string>
  oauthExchange?(code: string, verifier: string): Promise<IdentityGrant>
  sendOtp?(email: string): Promise<void>
  verifyOtp?(email: string, code: string): Promise<IdentityGrant>
  passwordLogin?(email: string, password: string): Promise<IdentityGrant>
}
const unavailable = () => new ApiError('AUTH_SERVICE_UNAVAILABLE', 503)
function origin(value: string) {
  const u = new URL(value)
  if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw Error('Identity endpoints must be HTTPS origins')
  return u.origin
}
/** Fixed destinations only. Never forward passwords to a caller-supplied origin or redirect. */
export class XcodexProvider implements IdentityProvider {
  readonly issuer: string
  readonly supabase: string
  constructor(portalOrigin: string, supabaseOrigin: string, private readonly request: typeof fetch = fetch) {
    this.issuer = origin(portalOrigin); this.supabase = origin(supabaseOrigin)
  }
  private async call(url: string, body?: unknown, headers: Record<string, string> = {}) {
    try {
      const response = await this.request(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) })
      const text = await response.text()
      if (text.length > 262144) throw unavailable()
      const data = JSON.parse(text) as Record<string, unknown>
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw unavailable()
      return { status: response.status, data }
    } catch { throw unavailable() }
  }
  private failure(status: number, data: Record<string, unknown>, verifying = false): never {
    if (status === 429) throw new ApiError('RATE_LIMITED', 429)
    if (status === 403 && data.error_code === 'otp_expired') throw new ApiError('AUTH_INVALID', 401)
    if (['flow_state_expired', 'flow_state_not_found', 'bad_code_verifier'].includes(String(data.error_code)) && status >= 400 && status < 500) throw new ApiError('AUTH_FLOW_EXPIRED', 401)
    if (status >= 500 || status >= 300 && status < 400) throw unavailable()
    if (status === 409) throw new ApiError('ACCOUNT_IDENTITY_CONFLICT', 409)
    if ((status === 403 && data.error === '计费账户未启用') || data.error_code === 'user_banned') throw new ApiError('ACCOUNT_DISABLED', 403)
    if ((status === 403 && data.error === '请先完成邮箱验证') || data.error_code === 'email_not_confirmed') throw new ApiError('EMAIL_NOT_VERIFIED', 403)
    if (status === 403) throw new ApiError('AUTH_ACCESS_DENIED', 403)
    if (status === 400 || status === 401 || status === 422) throw new ApiError(verifying ? 'REAUTH_REQUIRED' : 'AUTH_INVALID', 401)
    throw unavailable()
  }
  private async settings() {
    const { status, data } = await this.call(this.issuer + '/api/portal/config')
    if (status !== 200) this.failure(status, data)
    const parsed = z.object({ local_auth: z.boolean(), supabase: z.object({ enabled: z.boolean(), url: z.string(), publishable_key: z.string() }) }).safeParse(data)
    if (!parsed.success) throw unavailable()
    const cfg = parsed.data
    if (cfg.supabase.enabled && (cfg.supabase.url.replace(/\/$/, '') !== this.supabase || !cfg.supabase.publishable_key)) throw unavailable()
    return cfg
  }
  private async me(token: string) {
    const { status, data } = await this.call(this.issuer + '/api/portal/me', undefined, { Authorization: 'Bearer ' + token })
    if (status !== 200) this.failure(status, data, true)
    const parsed = z.object({ id: z.string().uuid(), email: z.string().email() }).safeParse(data)
    if (!parsed.success) throw unavailable()
    return parsed.data
  }
  private tokens(data: Record<string, unknown>) {
    const p = z.object({ access_token: z.string().min(1).max(16384), refresh_token: z.string().min(1).max(16384), expires_in: z.number().int().positive().max(86400) }).safeParse(data)
    if (!p.success) throw unavailable()
    return { token: p.data.access_token, refreshToken: p.data.refresh_token, expiresAt: Date.now() + p.data.expires_in * 1000 }
  }
  private async supabaseRequest(path: string, body: unknown) {
    const cfg = await this.settings()
    if (!cfg.supabase.enabled) throw unavailable()
    const r = await this.call(this.supabase + '/auth/v1/' + path, body, { apikey: cfg.supabase.publishable_key })
    if (r.status !== 200) this.failure(r.status, r.data)
    return r.data
  }
  private async grantFromTokens(data: Record<string, unknown>): Promise<IdentityGrant> {
    const tokens = this.tokens(data), user = await this.me(tokens.token)
    return { issuer: this.issuer, subject: user.id, email: user.email, provider: 'supabase', ...tokens }
  }
  async passwordLogin(email: string, password: string): Promise<IdentityGrant> {
    return this.grantFromTokens(await this.supabaseRequest('token?grant_type=password', { email, password }))
  }
  async oauthUrl(redirectTo: string, challenge: string): Promise<string> {
    const cfg = await this.settings()
    if (!cfg.supabase.enabled) throw unavailable()
    const url = new URL(this.supabase + '/auth/v1/authorize')
    url.search = new URLSearchParams({ provider: 'google', redirect_to: redirectTo, code_challenge: challenge, code_challenge_method: 's256' }).toString()
    return url.href
  }
  async oauthExchange(code: string, verifier: string): Promise<IdentityGrant> {
    return this.grantFromTokens(await this.supabaseRequest('token?grant_type=pkce', { auth_code: code, code_verifier: verifier }))
  }
  async sendOtp(email: string): Promise<void> {
    // Match the website's email-code login, without implicitly registering accounts.
    await this.supabaseRequest('otp', { email, create_user: false })
  }
  async verifyOtp(email: string, code: string): Promise<IdentityGrant> {
    return this.grantFromTokens(await this.supabaseRequest('verify', { email, token: code, type: 'email' }))
  }
  async login(email: string, password: string): Promise<IdentityGrant> {
    const cfg = await this.settings()
    if (cfg.local_auth) {
      const r = await this.call(this.issuer + '/api/portal/auth/login', { email, password })
      if (r.status === 200) {
        const token = r.data.token
        if (typeof token !== 'string' || !/^local_[a-f0-9]{64}$/.test(token)) throw unavailable()
        const user = await this.me(token)
        return { issuer: this.issuer, subject: user.id, email: user.email, provider: 'local', token, expiresAt: Date.now() + 7 * 86400_000 }
      }
      // A route 404 or a different business error must never trigger another login provider.
      if (!(r.status === 404 && r.data.error === '该邮箱不是本地账户')) this.failure(r.status, r.data)
    }
    if (!cfg.supabase.enabled) throw new ApiError('AUTH_INVALID', 401)
    const r = await this.call(this.supabase + '/auth/v1/token?grant_type=password', { email, password }, { apikey: cfg.supabase.publishable_key })
    if (r.status !== 200) this.failure(r.status, r.data)
    const tokens = this.tokens(r.data), user = await this.me(tokens.token)
    return { issuer: this.issuer, subject: user.id, email: user.email, provider: 'supabase', ...tokens }
  }
  async verify(value: IdentityGrant, checkpoint?: (grant: IdentityGrant) => void): Promise<IdentityGrant> {
    let grant = grantSchema.parse(value)
    if (grant.issuer !== this.issuer) throw new ApiError('ACCOUNT_IDENTITY_CONFLICT', 409)
    if (grant.provider === 'local' && grant.expiresAt <= Date.now()) throw new ApiError('REAUTH_REQUIRED', 401)
    if (grant.provider === 'supabase' && grant.expiresAt <= Date.now() + 60000) {
      if (!grant.refreshToken) throw new ApiError('REAUTH_REQUIRED', 401)
      const cfg = await this.settings()
      if (!cfg.supabase.enabled) throw new ApiError('REAUTH_REQUIRED', 401)
      const r = await this.call(this.supabase + '/auth/v1/token?grant_type=refresh_token', { refresh_token: grant.refreshToken }, { apikey: cfg.supabase.publishable_key })
      if (r.status !== 200) this.failure(r.status, r.data, true)
      grant = { ...grant, ...this.tokens(r.data) }
      // Preserve a rotated refresh credential even if the subsequent portal lookup is unavailable.
      // This checkpoint does not authorize the account or renew its validation lease.
      checkpoint?.(grant)
    }
    const user = await this.me(grant.token)
    if (user.id !== grant.subject) throw new ApiError('ACCOUNT_IDENTITY_CONFLICT', 409)
    return { ...grant, email: user.email }
  }
}

export const externalUserId = (g: IdentityGrant) => 'xcodex:' + hash(JSON.stringify([g.issuer, g.subject]))
const terminal = (e: ApiError) => ['ACCOUNT_DISABLED', 'EMAIL_NOT_VERIFIED', 'AUTH_ACCESS_DENIED', 'ACCOUNT_IDENTITY_CONFLICT', 'REAUTH_REQUIRED'].includes(e.code)
/** Upstream credentials are encrypted at rest; the key is supplied outside the data file. */
export class IdentitySessions {
  private readonly key: Buffer
  private cache = new Map<string, { until: number; error?: ApiError }>()
  private lastUsed = new Map<string, number>()
  private pending = new Map<string, Promise<void>>()
  private closed = false
  private timer: ReturnType<typeof setInterval>
  constructor(private readonly store: Store, private readonly provider: IdentityProvider, key: string) {
    if (!/^[a-f0-9]{64}$/i.test(key)) throw Error('DSH_XCODEX_CREDENTIAL_KEY must be 32 bytes encoded as hex')
    this.key = Buffer.from(key, 'hex')
    // Fail startup if the configured key cannot decrypt persisted grants; never silently erase identities.
    for (const [id, user] of store.users()) if (user.provider === 'xcodex') this.open(id)
    store.checkUser = id => this.requireCached(id)
    this.timer = setInterval(() => {
      for (const [id, u] of store.users()) if (u.provider === 'xcodex' && Date.now() - (this.lastUsed.get(id) ?? 0) < 90000 && this.pending.size < 8 && (this.cache.get(id)?.until ?? 0) - Date.now() < 30000) void this.ensure(id, true, false).catch(() => {})
    }, 10000)
    this.timer.unref()
  }
  close() { this.closed = true; clearInterval(this.timer) }
  private seal(id: string, grant: IdentityGrant) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(Buffer.from(id))
    const data = Buffer.concat([cipher.update(JSON.stringify(grant)), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url')
  }
  private open(id: string): IdentityGrant {
    try {
      const data = Buffer.from(this.store.user(id).grant ?? '', 'base64url')
      const decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12))
      decipher.setAAD(Buffer.from(id)); decipher.setAuthTag(data.subarray(12, 28))
      const grant = grantSchema.parse(JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString()))
      if (externalUserId(grant) !== id) throw Error('identity mismatch')
      return grant
    } catch { throw new ApiError('AUTH_SERVICE_UNAVAILABLE', 503) }
  }
  async login(email: string, password: string) {
    return this.accept(await this.provider.login(email, password))
  }
  accept(value: IdentityGrant) {
    const grant = grantSchema.parse(value), id = externalUserId(grant)
    if (this.closed) throw unavailable()
    this.store.setUser(id, grant.email, this.seal(id, grant))
    this.cache.set(id, { until: Math.min(Date.now() + 60000, grant.expiresAt) })
    return id
  }
  requireCached(id: string) {
    this.lastUsed.set(id, Date.now())
    if (this.store.user(id).provider === 'legacy') return
    const c = this.cache.get(id)
    if (c && c.until > Date.now()) { if (c.error) throw c.error; return }
    void this.ensure(id).catch(() => {})
    throw unavailable()
  }
  ensure(id: string, force = false, active = true): Promise<void> {
    if (active) this.lastUsed.set(id, Date.now())
    if (this.store.user(id).provider === 'legacy') return Promise.resolve()
    const c = this.cache.get(id)
    if (!force && c && c.until > Date.now()) return c.error ? Promise.reject(c.error) : Promise.resolve()
    const existing = this.pending.get(id)
    if (existing) return existing
    let original = this.store.user(id).grant
    const work = (async () => {
      try {
        const before = this.open(id), grant = await this.provider.verify(before, candidate => {
          if (this.closed || this.store.user(id).grant !== original) return
          if (externalUserId(candidate) !== id) throw new ApiError('ACCOUNT_IDENTITY_CONFLICT', 409)
          this.store.setUser(id, candidate.email, this.seal(id, candidate))
          original = this.store.user(id).grant
        })
        // A new login supersedes an in-flight verification; stale results cannot overwrite it.
        if (this.closed || this.store.user(id).grant !== original) return
        this.store.setUser(id, grant.email, this.seal(id, grant))
        this.cache.set(id, { until: Math.min(Date.now() + 60000, grant.expiresAt) })
      } catch (error) {
        if (this.closed || this.store.user(id).grant !== original) return
        const e = error instanceof ApiError ? error : unavailable()
        this.cache.set(id, { until: Date.now() + 10000, error: e })
        if (terminal(e)) this.store.invalidateUser(id)
        throw e
      }
    })().finally(() => this.pending.delete(id))
    this.pending.set(id, work)
    return work
  }
}
