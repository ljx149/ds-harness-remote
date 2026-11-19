import { describe, expect, it, vi } from 'vitest'
import { ManagedAgentRegistry } from '../src/managed-agents/registry.js'
import { ManagedAgentRuntime } from '../src/managed-agents/runtime.js'
import { ManagedCodexAdapter } from '../src/managed-agents/codex-adapter.js'
import { ManagedAcpAdapter } from '../src/managed-agents/acp-adapter.js'
import type { CodexAppServerInboundHandler, CodexAppServerLike } from '../src/codex/app-server.js'
import type { ManagedAgentConnection, ManagedAgentEvent } from '../src/managed-agents/types.js'

const capabilities = { rewind: false, compact: false, threadGoal: false, contextUsage: false, imagePrompts: false, steering: 'queue' as const, approvalEnforcement: 'provider' as const }
const input = { sessionId: 'managed-1', agent: 'codex', workspacePath: '/workspace/a' }

function transport() {
  let inbound: CodexAppServerInboundHandler = () => undefined
  const client: CodexAppServerLike = {
    start: vi.fn(async () => undefined), isReady: () => true,
    call: vi.fn(async (method) => method === 'thread/start' ? { thread: { id: 'thread-1' } } : method === 'session/new' ? { sessionId: 'acp-1' } : { turn: { id: 'turn-1' } }),
    respond: vi.fn(async () => undefined), respondError: vi.fn(async () => undefined),
    onInbound: handler => { inbound = handler; return () => { inbound = () => undefined } },
    onUnavailable: () => () => undefined, close: vi.fn(async () => undefined),
  }
  return { client, emit: (frame: Parameters<CodexAppServerInboundHandler>[0]) => inbound(frame) }
}

describe('managed agent runtime', () => {
  it('uses the Codex startup model instead of the first model in its catalog', async () => {
    const { client } = transport()
    vi.mocked(client.call).mockResolvedValueOnce({ thread: { id: 'thread-1' }, model: 'configured-model', reasoningEffort: 'high' })
    const connection = await new ManagedCodexAdapter(() => client).open(input, () => undefined)
    expect(connection.defaultModel).toEqual({ model: 'configured-model', reasoningEffort: 'high' })
    await connection.close()
  })
  it('coalesces session acquisition and rejects another workspace claiming it', async () => {
    const client = transport()
    const open = vi.fn((value, emit) => new ManagedCodexAdapter(() => client.client).open(value, emit))
    const runtime = new ManagedAgentRuntime(new ManagedAgentRegistry([{ definition: { agent: 'codex', title: 'Codex', icon: 'codex', capabilities }, adapter: { open } }]))
    const first = runtime.open(input, () => undefined)
    const second = runtime.open(input, () => undefined)
    expect(await first).toBe(await second)
    expect(open).toHaveBeenCalledTimes(1)
    await expect(runtime.open({ ...input, workspacePath: '/workspace/b' }, () => undefined)).rejects.toThrow('ownership')
    await runtime.closeAll()
    expect(client.client.close).toHaveBeenCalledTimes(1)
  })

  it('closes a process acquired after shutdown instead of leaking it', async () => {
    let finish!: (connection: ManagedAgentConnection) => void
    const close = vi.fn(async () => undefined)
    const runtime = new ManagedAgentRuntime(new ManagedAgentRegistry([{ definition: { agent: 'codex', title: 'Codex', icon: 'codex', capabilities }, adapter: { open: () => new Promise(resolve => { finish = resolve }) } }]))
    const opened = runtime.open(input, () => undefined)
    const rejected = expect(opened).rejects.toThrow('closed during startup')
    await Promise.resolve()
    const shutdown = runtime.closeAll()
    finish({ providerSessionId: 'thread-1', close, send: async () => ({ state: 'accepted' }), cancel: async () => undefined, approve: async () => undefined })
    await shutdown
    await rejected
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('keeps Codex approvals session scoped and suppresses duplicate final text', async () => {
    const { client, emit } = transport()
    const events: ManagedAgentEvent[] = []
    const connection = await new ManagedCodexAdapter(() => client).open(input, event => events.push(event))
    await connection.send({ messageId: 'message-1', text: 'hello' })
    emit({ kind: 'notification', method: 'item/agentMessage/delta', params: { threadId: 'thread-1', itemId: 'answer', delta: 'hello' } })
    emit({ kind: 'notification', method: 'item/completed', params: { threadId: 'thread-1', item: { id: 'answer', type: 'agentMessage', text: 'hello' } } })
    expect(events.filter(event => event.type === 'text')).toEqual([{ type: 'text', text: 'hello', itemId: 'answer' }])
    emit({ kind: 'request', id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'other-thread' } })
    expect(events.some(event => event.type === 'approval')).toBe(false)
    emit({ kind: 'request', id: 8, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1' } })
    const approval = events.find(event => event.type === 'approval')!
    if (approval.type !== 'approval') throw new Error('missing approval')
    await connection.approve(approval.requestId, 'reject-once')
    expect(client.respond).toHaveBeenCalledWith(8, { decision: 'decline' })
    await expect(connection.approve(approval.requestId, 'allow-once')).rejects.toThrow('no longer pending')
    await connection.close()
  })

  it('does not permit a new turn after ambiguous Codex submission', async () => {
    const { client } = transport()
    const connection = await new ManagedCodexAdapter(() => client).open(input, () => undefined)
    vi.mocked(client.call).mockRejectedValueOnce(new Error('timeout'))
    expect(await connection.send({ messageId: 'message-1', text: 'hello' })).toMatchObject({ state: 'unknown' })
    await expect(connection.send({ messageId: 'message-2', text: 'again' })).rejects.toThrow('already running')
    await connection.close()
  })

  it('releases an unavailable route so recovery resumes the persisted provider identity', async () => {
    let signal: ((event: ManagedAgentEvent) => void) | undefined
    const close = vi.fn(async () => undefined)
    const open = vi.fn(async (value, emit) => {
      signal = emit
      return { providerSessionId: value.providerSessionId ?? 'thread-existing', close, send: async () => ({ state: 'accepted' as const }), cancel: async () => undefined, approve: async () => undefined }
    })
    const runtime = new ManagedAgentRuntime(new ManagedAgentRegistry([{ definition: { agent: 'codex', title: 'Codex', icon: 'codex', capabilities }, adapter: { open } }]))
    await runtime.open(input, () => undefined)
    signal?.({ type: 'unavailable', code: 'PROCESS_EXITED' })
    await runtime.open({ ...input, providerSessionId: 'thread-existing' }, () => undefined)
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ providerSessionId: 'thread-existing' }), expect.any(Function))
    expect(close).toHaveBeenCalledTimes(1)
    await runtime.closeAll()
  })

  it('does not scan external ACP history and only allows offered single-use approvals', async () => {
    const { client, emit } = transport()
    const events: ManagedAgentEvent[] = []
    const connection = await new ManagedAcpAdapter(() => client).open({ ...input, agent: 'claude' }, event => events.push(event))
    expect(client.call).toHaveBeenCalledWith('session/new', { cwd: '/workspace/a', mcpServers: [] })
    emit({ kind: 'request', id: 2, method: 'session/request_permission', params: { sessionId: 'acp-1', options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'always', kind: 'allow_always' }, { optionId: 'deny', kind: 'reject_once' }] } })
    const approval = events.find(event => event.type === 'approval')!
    if (approval.type !== 'approval') throw new Error('missing approval')
    expect(approval.choices).toEqual(['allow-once', 'reject-once', 'cancel'])
    await expect(connection.approve(approval.requestId, 'always')).rejects.toThrow('invalid')
    await connection.approve(approval.requestId, 'reject-once')
    expect(client.respond).toHaveBeenCalledWith(2, { outcome: { outcome: 'selected', optionId: 'deny' } })
    await connection.close()
  })
})
