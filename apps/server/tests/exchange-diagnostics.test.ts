import { describe, expect, it } from 'vitest'
import { deviceExchangeSchema, ExchangeValidationError, parseDeviceExchange } from '../src/device-login.js'
import { Logger } from '../src/logger.js'
const valid = { requestId: 'r'.repeat(43), pickupToken: 'p'.repeat(43), code: 'c'.repeat(43), codeVerifier: 'v'.repeat(43) }
function failure(input: unknown): ExchangeValidationError {
  try { parseDeviceExchange(input) } catch (error) { expect(error).toBeInstanceOf(ExchangeValidationError); return error as ExchangeValidationError }
  throw new Error('Expected validation failure')
}
describe('exchange metadata-only diagnostics', () => {
  it('preserves the exact schema acceptance and reports lengths, types, missing and extra fields', () => {
    expect(parseDeviceExchange(valid)).toEqual(valid)
    const samples = [null, [], 1, {}, { ...valid, codeVerifier: 'secret'.repeat(15) },
      { ...valid, code: 42 }, { ...valid, code: null }, { ...valid, code: ['secret'] },
      { ...valid, state: 'do-not-log-state' }, { ...valid, code: '+'.repeat(43) }]
    for (const value of samples) {
      expect(deviceExchangeSchema.safeParse(value).success).toBe(false)
      const error = failure(value)
      expect(error.code).toBe('INVALID_MESSAGE'); expect(error.status).toBe(400)
    }
    expect(failure({ ...valid, codeVerifier: 'v'.repeat(64) }).failures).toEqual([
      { field: 'codeVerifier', actualType: 'string', length: 64, reason: 'invalid_length' },
    ])
    expect(failure({ ...valid, state: 'private-state' }).failures).toEqual([
      { field: 'state', actualType: 'string', length: 13, reason: 'unrecognized_field' },
    ])
    expect(failure({}).failures.every(value => value.reason === 'required')).toBe(true)
    expect(failure({ ...valid, code: 42 }).failures).toEqual([{ field: 'code', actualType: 'number', reason: 'invalid_type' }])
  })
  it('never logs credential values, nested content or arbitrary extra property names; bounds output', () => {
    const nested = { value: 'private-nested-token' }
    const input = { ...valid, codeVerifier: 'PRIVATE-VERIFIER'.repeat(5), state: nested, ['PRIVATE-TOKEN-AS-KEY'.repeat(5)]: 'private-value' }
    const error = failure(input)
    let line = ''
    new Logger('test', 'warn', value => { line = value }).warn('device_exchange_rejected', { failures: error.failures })
    for (const secret of [...Object.values(valid), input.codeVerifier, nested.value, 'PRIVATE-TOKEN-AS-KEY', 'private-value']) expect(line).not.toContain(secret)
    expect(line).toContain('codeVerifier'); expect(line).toContain('invalid_length')
    expect(line).toContain('<unrecognized-field>')
    expect(failure(Object.fromEntries(Array.from({ length: 100 }, (_, i) => ['field' + i, 'secret']))).failures.length).toBeLessThanOrEqual(16)
  })
})
