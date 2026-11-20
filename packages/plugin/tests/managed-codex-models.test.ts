import { describe, expect, it, vi } from 'vitest'
import { ManagedCodexAdapter } from '../src/managed-agents/codex-adapter.js'
import type { CodexAppServerLike } from '../src/codex/app-server.js'

function fixture(call: CodexAppServerLike['call']) {
  const client: CodexAppServerLike = {
    start: async () => {}, isReady: () => true, call: vi.fn(call),
    respond: async () => {}, respondError: async () => {},
    onInbound: () => () => {}, onUnavailable: () => () => {}, close: vi.fn(async () => {}),
  }
  return { client, adapter: new ManagedCodexAdapter(() => client) }
}
const input = { sessionId: 's1', agent: 'codex', workspacePath: '/workspace' }
describe('Codex model discovery', () => {
  it('starts paginated discovery while thread startup is pending, then reuses the catalog for selection', async () => {
    let release!: (value: unknown) => void
    const started = new Promise(resolve => { release = resolve })
    const { client, adapter } = fixture(async (method, params) => {
      if (method === 'thread/start') return started
      if (method === 'model/list') return (params as { cursor?: string }).cursor
        ? { data: [{ model: 'second' }] } : { data: [{ model: 'first' }], nextCursor: 'page2' }
      throw Error('unexpected')
    })
    const opening = adapter.open(input, () => {})
    await vi.waitFor(() => expect(client.call).toHaveBeenCalledWith('model/list', { cursor: 'page2' }))
    release({ thread: { id: 'thread1' }, model: 'configured' })
    const connection = await opening
    const [a, b] = await Promise.all([connection.models!(), connection.models!()])
    expect(a).toEqual({ data: [{ model: 'first' }, { model: 'second' }] })
    expect(b).toBe(a)
    expect(connection.defaultModel).toEqual({ model: 'configured' })
    expect(vi.mocked(client.call).mock.calls.filter(([m]) => m === 'model/list')).toHaveLength(2)
    await connection.models!({ refresh: true })
    expect(vi.mocked(client.call).mock.calls.filter(([m]) => m === 'model/list')).toHaveLength(4)
    await connection.close()
    await expect(connection.models!()).rejects.toThrow('unavailable')
  })

  it('coalesces pending reads and logs only fixed stage metadata when enabled', async () => {
    let release!: (value: unknown) => void
    const pending = new Promise(resolve => { release = resolve })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubEnv('XAGENT_MODEL_TIMING', '1')
    const { client, adapter } = fixture(async method => method === 'thread/start'
      ? { thread: { id: 'secret-thread' }, model: 'secret-model' } : pending)
    try {
      const connection = await adapter.open(input, () => {})
      const a = connection.models!(), b = connection.models!({ refresh: true })
      expect(a).toBe(b)
      expect(vi.mocked(client.call).mock.calls.filter(([m]) => m === 'model/list')).toHaveLength(1)
      release({ data: [{ model: 'secret-model' }] })
      await a
      const records = log.mock.calls.map(args => JSON.parse(String(args[1])))
      expect(records.map(r => r.stage)).toEqual(['startup-initialize', 'thread-start', 'model-list-page'])
      for (const record of records) expect(Object.keys(record).sort()).toEqual(['elapsedMs', 'ok', 'stage', 'trace'])
      expect(JSON.stringify(log.mock.calls)).not.toContain('secret')
      await connection.close()
    } finally { log.mockRestore(); vi.unstubAllEnvs() }
  })

  it('does not cache failures or share models with another connection and expires after 30 seconds', async () => {
    let fail = true, model = 'a', now = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    const { client, adapter } = fixture(async method => {
      if (method === 'thread/start') return { thread: { id: 'thread1' } }
      if (fail) throw Error('model unavailable')
      return { data: [{ model }] }
    })
    try {
      const first = await adapter.open(input, () => {})
      await expect(first.models!()).rejects.toThrow('model unavailable')
      fail = false
      expect(await first.models!()).toEqual({ data: [{ model: 'a' }] })
      model = 'b'
      expect(await first.models!()).toEqual({ data: [{ model: 'a' }] })
      const second = await adapter.open({ ...input, sessionId: 's2', workspacePath: '/other' }, () => {})
      expect(await second.models!()).toEqual({ data: [{ model: 'b' }] })
      now = 30_001
      expect(await first.models!()).toEqual({ data: [{ model: 'b' }] })
      await first.close(); await second.close()
      expect(client.close).toHaveBeenCalledTimes(2)
    } finally { clock.mockRestore() }
  })
})
