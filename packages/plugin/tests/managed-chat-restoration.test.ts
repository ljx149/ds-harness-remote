import { describe, expect, it, vi } from 'vitest'
import { ManagedLaunchRegistry } from '../src/managed-agents/launch.js'
import { ClaudeChatProjection } from '../src/managed-agents/claude-projection.js'
import { ManagedCodexAdapter } from '../src/managed-agents/codex-adapter.js'
import type { CodexAppServerLike, CodexAppServerInboundHandler } from '../src/codex/app-server.js'
import type { ManagedAgentEvent } from '../src/managed-agents/types.js'

describe('reviewed chat restoration boundaries', () => {
  it('inherits native config by default but custom profiles remove inherited account credentials', () => {
    const registry = new ManagedLaunchRegistry({ profiles: [{ id: 'work', label: 'Work', codexHome: '/profiles/work' }] })
    const input = { sessionId: 's', agent: 'codex', workspacePath: '/workspace' }
    expect(registry.resolve(input).environment({ OPENAI_API_KEY: 'sentinel', PATH: '/bin' })).toEqual({ OPENAI_API_KEY: 'sentinel', PATH: '/bin' })
    const custom = registry.resolve({ ...input, selection: { profileId: 'work' } })
    expect(custom.environment({ OPENAI_API_KEY: 'sentinel', CODEX_HOME: '/other', PATH: '/bin' })).toEqual({ CODEX_HOME: '/profiles/work', PATH: '/bin' })
    expect(JSON.stringify(registry.options('codex'))).not.toContain('/profiles')
    const changed = new ManagedLaunchRegistry({ profiles: [{ id: 'work', label: 'Work', codexHome: '/profiles/other' }] })
    expect(() => changed.resolve({ ...input, selection: { profileId: 'work' }, previousFingerprint: custom.ownerFingerprint })).toThrow('changed')
    expect(() => registry.resolve({ ...input, agent: 'claude', selection: { profileId: 'work' } })).toThrow('unavailable')
  })
  it('passes only the ownership schema fields into the durable spawn factory', () => {
    const factory = vi.fn(() => (() => { throw new Error('No child requested') }) as any)
    const registry = new ManagedLaunchRegistry({}, undefined, factory)
    registry.resolve({ sessionId: 's', agent: 'codex', workspacePath: '/workspace', selection: { profileId: 'host' } })
    expect(factory).toHaveBeenCalledWith({ sessionId: 's', agent: 'codex' })
  })
  it('reconciles Claude partial and final block identities instead of displaying them twice', () => {
    const events: ManagedAgentEvent[] = [], projection = new ClaudeChatProjection(event => events.push(event))
    projection.observe({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm' } } })
    projection.observe({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } } })
    projection.observe({ type: 'assistant', uuid: 'different-envelope', message: { id: 'm', content: [{ type: 'text', text: 'partial final' }] } })
    expect(events).toEqual([{ type: 'text-delta', itemId: 'claude:m:0', text: 'partial' }, { type: 'text', itemId: 'claude:m:0', text: 'partial final' }])
    projection.observe({ type: 'assistant', parent_tool_use_id: 'child', message: { id: 'child', content: [{ type: 'text', text: 'private child stream' }] } })
    expect(events).toHaveLength(2)
  })
  it('answers Codex user-input requests only once and never accepts a foreign thread', async () => {
    let inbound: CodexAppServerInboundHandler = () => {}
    const client: CodexAppServerLike = {
      start: async () => {}, isReady: () => true, call: vi.fn(async () => ({ thread: { id: 'owned' } })),
      respond: vi.fn(async () => {}), respondError: vi.fn(async () => {}), close: async () => {},
      onInbound: callback => { inbound = callback; return () => {} }, onUnavailable: () => () => {},
    }
    const events: ManagedAgentEvent[] = []
    const connection = await new ManagedCodexAdapter(() => client).open({ sessionId: 's', agent: 'codex', workspacePath: '/workspace' }, event => events.push(event))
    const params = { threadId: 'owned', questions: [{ id: 'q', question: 'Choose', options: [{ label: 'A' }] }] }
    inbound({ kind: 'request', id: 1, method: 'item/tool/requestUserInput', params: { ...params, threadId: 'foreign' } })
    expect(events).toHaveLength(0)
    inbound({ kind: 'request', id: 2, method: 'item/tool/requestUserInput', params })
    const question = events[0]!; if (question.type !== 'question') throw new Error('Missing question')
    await connection.answerQuestion!(question.requestId, { q: ['A'] })
    expect(client.respond).toHaveBeenCalledWith(2, { answers: { q: { answers: ['A'] } } })
    await expect(connection.answerQuestion!(question.requestId, { q: ['A'] })).rejects.toThrow('EXPIRED')
    expect(client.respond).toHaveBeenCalledTimes(1)
    await connection.close()
  })
})
