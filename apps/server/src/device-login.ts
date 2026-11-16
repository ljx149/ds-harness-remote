import { createHash } from 'node:crypto'
import { z } from 'zod'
import { accountDeviceDescriptorSchema } from '@dsh-remote/protocol'
import { ApiError, Store, equal, hash, secret } from './store.js'

const proof = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const pickup = z.object({ requestId: proof, pickupToken: proof })
/** Exact current wire contract; diagnostics must not change acceptance. */
export const deviceExchangeSchema = pickup.extend({ code: proof, codeVerifier: proof }).strict()
const exchangeFields = ['requestId', 'pickupToken', 'code', 'codeVerifier'] as const
const diagnosticFieldNames = new Set<string>([...exchangeFields, 'state', 'device', 'redirectUri',
  'code_verifier', 'request_id', 'pickup_token', 'authorizationCode', 'verifier'])
export interface ExchangeFieldDiagnostic {
  field: string
  actualType: string
  length?: number
  reason: 'required' | 'invalid_type' | 'invalid_length' | 'invalid_characters' | 'unrecognized_field'
}
export class ExchangeValidationError extends ApiError {
  constructor(readonly failures: ExchangeFieldDiagnostic[]) { super('INVALID_MESSAGE', 400) }
}
function fieldShape(field: string, value: unknown) {
  const actualType = value === undefined ? 'missing' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  return { field, actualType, ...(typeof value === 'string' || Array.isArray(value) ? { length: value.length } : {}) }
}
export function parseDeviceExchange(input: unknown) {
  const parsed = deviceExchangeSchema.safeParse(input)
  if (parsed.success) return parsed.data
  const failures: ExchangeFieldDiagnostic[] = []
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    failures.push({ ...fieldShape('$body', input), reason: 'invalid_type' })
  } else {
    const object = input as Record<string, unknown>
    for (const field of exchangeFields) {
      const value = Object.hasOwn(object, field) ? object[field] : undefined
      if (typeof value !== 'string') failures.push({ ...fieldShape(field, value), reason: value === undefined ? 'required' : 'invalid_type' })
      else if (value.length !== 43) failures.push({ ...fieldShape(field, value), reason: 'invalid_length' })
      else if (!/^[A-Za-z0-9_-]+$/.test(value)) failures.push({ ...fieldShape(field, value), reason: 'invalid_characters' })
    }
    for (const field of Object.keys(object)) {
      if ((exchangeFields as readonly string[]).includes(field)) continue
      // Do not echo arbitrary property names: callers could put a secret in a key.
      failures.push({ ...fieldShape(diagnosticFieldNames.has(field) ? field : '<unrecognized-field>', object[field]), reason: 'unrecognized_field' })
      if (failures.length >= 16) break
    }
  }
  throw new ExchangeValidationError(failures)
}

const startSchema = z.object({
  device: accountDeviceDescriptorSchema,
  codeChallenge: proof, state: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  redirectUri: z.string().max(2048).optional(),
}).strict()
type Flow = z.infer<typeof startSchema> & {
  requestId: string; browserHash: string; pickupHash: string; expiresAt: number
  ownerId?: string; code?: string; cancelled?: boolean
  result?: ReturnType<Store['register']> & { deviceId: string; account: string }
  exchangedAt?: number
}

/** Ephemeral, device-bound browser handoff. No account or upstream tokens leave it. */
export class DeviceLogins {
  private flows = new Map<string, Flow>()
  private redirects: Set<string>
  constructor(private store: Store, private origin: string, redirects: readonly string[] = [], private now = Date.now) {
    this.redirects = new Set(redirects)
    for (const value of redirects) {
      const url = new URL(value)
      if (['http:', 'javascript:', 'data:', 'file:', 'ftp:'].includes(url.protocol) || url.hash || url.username || url.password
        || ['code', 'state', 'requestId'].some(key => url.searchParams.has(key))) throw new Error('Invalid device login redirect configuration')
    }
  }
  start(input: unknown) {
    const data = startSchema.parse(input)
    if (data.redirectUri && !this.redirects.has(data.redirectUri)) throw new ApiError('DEVICE_LOGIN_REDIRECT_DENIED', 400)
    for (const [id, flow] of this.flows) if (flow.expiresAt <= this.now()) this.flows.delete(id)
    if (this.flows.size >= 256) throw new ApiError('RATE_LIMITED', 429)
    const requestId = secret(), pickupToken = secret(), browserToken = secret(), expiresAt = this.now() + 600_000
    this.flows.set(requestId, { ...data, requestId, pickupHash: hash(pickupToken), browserHash: hash(browserToken), expiresAt })
    return { requestId, pickupToken, expiresAt, interval: 2, loginUrl: `${this.origin}/app/login#device_login=${browserToken}` }
  }
  browser(token: string) {
    proof.parse(token)
    const flow = [...this.flows.values()].find(f => equal(f.browserHash, hash(token)))
    if (!flow) throw new ApiError('DEVICE_LOGIN_EXPIRED', 410)
    this.active(flow)
    return flow
  }
  complete(token: string, ownerId: string) {
    const flow = this.browser(token)
    if (flow.ownerId && flow.ownerId !== ownerId) throw new ApiError('DEVICE_LOGIN_CONFLICT', 409)
    flow.ownerId = ownerId
    flow.code ??= secret()
    let redirectUrl: string | undefined
    if (flow.redirectUri) {
      const url = new URL(flow.redirectUri)
      url.searchParams.set('code', flow.code); url.searchParams.set('state', flow.state); url.searchParams.set('requestId', flow.requestId)
      redirectUrl = url.href
    }
    return { status: 'complete', ...(redirectUrl ? { redirectUrl } : {}) }
  }
  private lookup(input: unknown) {
    const data = pickup.parse(input), flow = this.flows.get(data.requestId)
    if (!flow || !equal(flow.pickupHash, hash(data.pickupToken))) throw new ApiError('DEVICE_LOGIN_INVALID', 401)
    return flow
  }
  private active(flow: Flow) {
    if (flow.expiresAt <= this.now()) throw new ApiError('DEVICE_LOGIN_EXPIRED', 410)
    if (flow.cancelled) throw new ApiError('DEVICE_LOGIN_CANCELLED', 410)
  }
  poll(input: unknown) {
    const flow = this.lookup(input)
    if (flow.expiresAt <= this.now()) return { status: 'expired' }
    if (flow.cancelled) return { status: 'cancelled' }
    return flow.code ? { status: 'ready', code: flow.code, state: flow.state } : { status: 'pending' }
  }
  cancel(input: unknown) {
    const flow = this.lookup(input)
    this.active(flow)
    if (flow.result) throw new ApiError('DEVICE_LOGIN_CONFLICT', 409)
    flow.cancelled = true
    return { status: 'cancelled' }
  }
  async exchange(input: unknown, ensure: (id: string) => Promise<unknown>) {
    const data = parseDeviceExchange(input)
    const flow = this.lookup(data)
    this.active(flow)
    if (!flow.ownerId || !flow.code || !equal(flow.code, data.code)
      || !equal(flow.codeChallenge, createHash('sha256').update(data.codeVerifier).digest('base64url'))) throw new ApiError('DEVICE_LOGIN_INVALID', 401)
    await ensure(flow.ownerId)
    // No await after this recheck: concurrent requests register exactly once.
    this.active(flow)
    if (flow.result) {
      if (this.now() - flow.exchangedAt! > 60_000) throw new ApiError('DEVICE_LOGIN_EXPIRED', 410)
      this.store.authenticate(flow.result.accessToken)
      return flow.result
    }
    const result = this.store.register(flow.device, flow.ownerId)
    flow.result = { ...result, deviceId: flow.device.deviceId, account: this.store.user(flow.ownerId).account }
    flow.exchangedAt = this.now()
    return flow.result
  }
}
