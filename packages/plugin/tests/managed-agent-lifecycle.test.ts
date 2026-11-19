import { describe, expect, it, vi } from 'vitest'
import { ManagedAgentRuntime } from '../src/managed-agents/runtime.js'
import { ManagedAgentRegistry } from '../src/managed-agents/registry.js'
import type { ManagedAgentConnection, ManagedAgentEmit } from '../src/managed-agents/types.js'

const input = { sessionId: 'managed-session', agent: 'codex', workspacePath: '/workspace' }
function setup() {
  let now = 0
  let emit: ManagedAgentEmit = () => {}
  const connection: ManagedAgentConnection = {
    providerSessionId: 'provider-session', close: vi.fn(async () => {}),
    send: vi.fn(async () => ({ state: 'accepted' as const })),
    cancel: vi.fn(async () => {}), approve: vi.fn(async () => {}),
    isIdle: vi.fn(async () => 'idle' as const),
  }
  const open = vi.fn(async (_input: unknown, callback: ManagedAgentEmit) => { emit = callback; return connection })
  const registry = new ManagedAgentRegistry([{ definition: { agent: 'codex', title: 'Codex', icon: 'codex', capabilities: {
    rewind: false, compact: false, threadGoal: false, contextUsage: false, imagePrompts: false,
    steering: 'queue', approvalEnforcement: 'provider',
  } }, adapter: { open } }])
  const runtime = new ManagedAgentRuntime(registry, { now: () => now, closeTimeoutMs: 25 })
  return { runtime, connection, open, emit: (event: Parameters<ManagedAgentEmit>[0]) => emit(event), clock: (value: number) => { now = value } }
}

describe('Host-owned managed Agent lifecycle', () => {
  it('retains ownership after a failed close, refusing reopen until cleanup succeeds', async () => {
    const f = setup()
    const connection = await f.runtime.open(input, () => {})
    const generation = f.runtime.status(input.sessionId).generation
    vi.mocked(f.connection.close).mockRejectedValueOnce(new Error('cleanup failed'))
    await expect(f.runtime.close(input.sessionId)).rejects.toThrow('cleanup failed')
    expect(f.runtime.status(input.sessionId)).toMatchObject({ state: 'blocked', generation, reason: 'cleanup-unconfirmed' })
    await expect(f.runtime.open(input, () => {})).rejects.toThrow('blocked')
    await expect(connection.send({ messageId: 'stale', text: 'hello' })).rejects.toThrow('retired or blocked')
    expect(f.open).toHaveBeenCalledTimes(1)
    await f.runtime.close(input.sessionId)
    await f.runtime.open(input, () => {})
    expect(f.runtime.status(input.sessionId).generation).not.toBe(generation)
    await expect(connection.close()).rejects.toThrow('retired')
    expect(f.runtime.status(input.sessionId).state).toBe('ready')
    await f.runtime.closeAll()
  })
  it('waits for unavailable-provider cleanup before acquiring a replacement', async () => {
    const f = setup()
    await f.runtime.open(input, () => {})
    let resolve!: () => void
    vi.mocked(f.connection.close).mockImplementationOnce(() => new Promise<void>(done => { resolve = done }))
    f.emit({ type: 'unavailable', code: 'closed-transport' })
    const replacement = f.runtime.open({ ...input, providerSessionId: 'provider-session' }, () => {})
    expect(f.runtime.status(input.sessionId).state).toBe('closing')
    expect(f.open).toHaveBeenCalledTimes(1)
    resolve(); await replacement
    expect(f.open).toHaveBeenCalledTimes(2)
    await f.runtime.closeAll()
  })
  it('requires a fresh explicit idle result, not elapsed time or viewer disconnect', async () => {
    const f = setup()
    await f.runtime.open(input, () => {})
    f.clock(10000)
    vi.mocked(f.connection.isIdle!).mockResolvedValueOnce('unknown').mockResolvedValueOnce('busy')
    expect(await f.runtime.cleanupIdle(input.sessionId, 100)).toBe(false)
    expect(await f.runtime.cleanupIdle(input.sessionId, 100)).toBe(false)
    expect(f.connection.close).not.toHaveBeenCalled()
    expect(await f.runtime.cleanupIdle(input.sessionId, 100)).toBe(true)
    expect(f.connection.close).toHaveBeenCalledTimes(1)
  })
  it('does not close when new work races an idle probe', async () => {
    const f = setup()
    const connection = await f.runtime.open(input, () => {})
    f.clock(10000)
    let resolve!: (value: 'idle') => void
    vi.mocked(f.connection.isIdle!).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const cleanup = f.runtime.cleanupIdle(input.sessionId, 100)
    await connection.send({ messageId: 'new', text: 'do work' })
    resolve('idle')
    expect(await cleanup).toBe(false)
    expect(f.connection.close).not.toHaveBeenCalled()
    await f.runtime.closeAll()
  })
  it('blocks an uncertain startup instead of silently reacquiring another process', async () => {
    const f = setup()
    f.open.mockRejectedValueOnce(new Error('startup outcome unknown'))
    await expect(f.runtime.open(input, () => {})).rejects.toThrow('startup outcome unknown')
    expect(f.runtime.status(input.sessionId).state).toBe('blocked')
    await expect(f.runtime.open(input, () => {})).rejects.toThrow('blocked')
    expect(f.open).toHaveBeenCalledTimes(1)
    await expect(f.runtime.closeAll()).rejects.toThrow('ownership remains blocked')
  })
  it('bounds a hanging close while preserving its fence until eventual completion', async () => {
    const f = setup()
    await f.runtime.open(input, () => {})
    let resolve!: () => void
    vi.mocked(f.connection.close).mockImplementationOnce(() => new Promise<void>(done => { resolve = done }))
    await expect(f.runtime.close(input.sessionId)).rejects.toThrow('deadline exceeded')
    expect(f.runtime.status(input.sessionId).state).toBe('blocked')
    await expect(f.runtime.open(input, () => {})).rejects.toThrow('blocked')
    resolve()
    await vi.waitFor(() => expect(f.runtime.status(input.sessionId).state).toBe('absent'))
  })
})
