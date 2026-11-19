import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEvent, createRpcRequest, type RemoteMessage } from '@dsh-remote/protocol'
import { ConnectionController } from '../src/connection-controller.js'
import { RpcRouter } from '../src/rpc-router.js'
import { HarnessRemoteBridge } from '../src/harness-remote-bridge.js'
import type { IdentityStore } from '../src/identity-store.js'
import type { AuthenticatedPeerChannel } from '../src/types.js'
import { ManagedSessionStore } from '../src/managed-session-store/index.js'
import { ManagedAgentBackend } from '../src/managed-agent-backend.js'
import { ManagedAgentRuntime } from '../src/managed-agents/runtime.js'
import { ManagedAgentRegistry } from '../src/managed-agents/registry.js'
import type { ManagedAgentAdapter, ManagedAgentEmit, ManagedAgentDispatch } from '../src/managed-agents/types.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
function fixture(existingDirectory?: string, services: ConstructorParameters<typeof ManagedAgentBackend>[4] = {}) {
  const directory = existingDirectory ?? mkdtempSync(join(tmpdir(), 'managed-backend-'))
  const store = ManagedSessionStore.open(directory)
  let emit: ManagedAgentEmit = () => {}
  let principal: { ownerId: string; hostId: string } | undefined = { ownerId: 'owner', hostId: 'host' }
  let workspaces = [{ workspaceId: 'a', path: '/project/a' }, { workspaceId: 'b', path: '/project/b' }]
  let workspaceResolver = async (): Promise<typeof workspaces> => workspaces
  const send = vi.fn(async (_input: { messageId: string; text: string }): Promise<ManagedAgentDispatch> => ({ state: 'accepted', providerTurnId: 'turn-1' }))
  const cancel = vi.fn(async () => {}), close = vi.fn(async () => {}), approve = vi.fn(async () => {})
  const models = vi.fn(async (): Promise<unknown> => ({ data: [{ id: 'gpt-test', model: 'gpt-test', displayName: 'Test model', supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'low' }] }] }))
  const setOption = vi.fn(async (_key: string, _value: string): Promise<void> => {})
  const open = vi.fn<ManagedAgentAdapter['open']>(async (input, callback) => {
    emit = callback
    return { providerSessionId: input.providerSessionId ?? 'provider-1', send, cancel, close, approve, models, setOption }
  })
  const registry = new ManagedAgentRegistry([{ definition: { agent: 'codex', title: 'Codex', icon: 'codex', capabilities: {
    rewind: false, compact: false, threadGoal: false, contextUsage: false, imagePrompts: false, steering: 'queue', approvalEnforcement: 'provider',
  } }, adapter: { open } }])
  const runtime = new ManagedAgentRuntime(registry)
  const backend = new ManagedAgentBackend(store, runtime, () => principal, async () => workspaceResolver(), services)
  cleanups.push(async () => { await backend.close(); rmSync(directory, { recursive: true, force: true }) })
  const call = async (endpoint: string, request: Record<string, unknown>) => {
    const result = await backend.dispatch(endpoint, { args: request }, new AbortController().signal)
    if (!result.ok) throw new Error(result.error.message)
    return result.value as any
  }
  const create = async (workspaceId = 'a', operationId = 'create-a') => (await call('managedAgent/create', { workspaceId, operationId, agentId: 'codex' })).sessionId as string
  const prompt = (sessionId: string, requestId = 'message-1', text = 'hello') => call('session/prompt', { sessionId, requestId, content: [{ type: 'text', text }] })
  return { directory, backend, store, runtime, open, send, close, cancel, approve, models, setOption, call, create, prompt,
    emit: (event: Parameters<ManagedAgentEmit>[0]) => emit(event),
    captureEmitter: () => emit,
    setPrincipal: (value: typeof principal) => { principal = value },
    setWorkspaces: (value: typeof workspaces) => { workspaces = value },
    setWorkspaceResolver: (value: typeof workspaceResolver) => { workspaceResolver = value },
  }
}
describe('managed backend integration', () => {
  it('advertises implemented mobile capabilities in discovery and session snapshots without probing a CLI', async () => {
    const f = fixture(), sessionId = await f.create()
    const identity = { agentId: 'codex', name: 'Codex', registered: true, availability: 'unverified', capabilities: {
      textPrompts: true, modelSelection: true, reasoningEffort: true, archive: true, unarchive: true,
      imagePrompts: false, fileAttachments: false, steering: false, queueWhileBusy: false, fork: false, compact: false,
    } }
    expect((await f.call('managedAgent/agents', {})).items[0]).toMatchObject({ id: 'codex', ...identity })
    expect((await f.backend.catalog())[0]!.summary.projections.values.managedAgent).toMatchObject(identity)
    const controller = new AbortController()
    const stream = await f.backend.open('session/follow', { args: { sessionId } }, controller.signal)
    const iterator = stream[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toMatchObject({ type: 'snapshot', projections: { values: { managedAgent: identity } } })
    controller.abort(); await iterator.return?.()
    expect(f.open).not.toHaveBeenCalled()
  })
  it('rejects attachment receipts rather than silently sending only the text', async () => {
    const f = fixture(), sessionId = await f.create()
    await expect(f.call('session/prompt', { sessionId, requestId: 'attachment', content: [{ type: 'text', text: 'inspect file' }], fileReceiptIds: ['receipt'] })).rejects.toThrow('MANAGED_ATTACHMENTS_NOT_SUPPORTED')
    expect(f.send).not.toHaveBeenCalled()
    expect(f.open).not.toHaveBeenCalled()
    await f.call('session/prompt', { sessionId, requestId: 'text', content: [{ type: 'text', text: 'hello' }], fileReceiptIds: [] })
    expect(f.send).toHaveBeenCalledTimes(1)
  })

  it('archives and restores only the scoped session, preserving native archives and history across restart', async () => {
    const f = fixture(undefined, { nativeArchived: async () => ['native-archived'] })
    const sessionId = await f.create()
    await f.prompt(sessionId)
    expect(await f.backend.dispatch('workspace/archiveSession', { args: { sessionId } }, new AbortController().signal)).toMatchObject({ ok: false, error: { code: 'workspace/session-active' } })
    expect(f.cancel).not.toHaveBeenCalled()
    const result = await f.call('workspace/archiveSession', { sessionId, stopActivity: true })
    expect(result.archivedSessionIds).toEqual(['native-archived', sessionId])
    expect(f.cancel).toHaveBeenCalledTimes(1)
    expect((await f.backend.catalog())[0]).toMatchObject({ archived: true, summary: { blank: false } })
    await f.backend.close()
    const restored = fixture(f.directory, { nativeArchived: async () => ['native-archived'] })
    expect((await restored.backend.catalog())[0]).toMatchObject({ archived: true })
    expect(await restored.call('workspace/unarchiveSession', { sessionId })).toEqual({ archivedSessionIds: ['native-archived'] })
    expect((await restored.backend.catalog())[0]).toMatchObject({ archived: false, summary: { blank: false } })
    restored.setPrincipal({ ownerId: 'other', hostId: 'host' })
    await expect(restored.call('workspace/archiveSession', { sessionId })).rejects.toThrow('MANAGED_SESSION_NOT_FOUND')
  })
  it('generates a model title once without injecting a naming prompt into the chat', async () => {
    const generateTitle = vi.fn(async () => '登录接口排查')
    const f = fixture(undefined, { generateTitle }), sessionId = await f.create()
    await f.call('session/selectModel', { sessionId, provider: 'codex', model: 'gpt-test' })
    await f.prompt(sessionId, 'first', '请帮我检查这个登录接口为什么不能用了')
    await vi.waitFor(async () => expect((await f.backend.catalog())[0]!.summary.projections.values.title).toBe('登录接口排查'))
    expect(generateTitle).toHaveBeenCalledWith(expect.objectContaining({ agent: 'codex', model: 'gpt-test', cwd: '/project/a' }))
    await f.prompt(sessionId, 'first', '请帮我检查这个登录接口为什么不能用了')
    expect(generateTitle).toHaveBeenCalledTimes(1)
    expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('keeps manual titles when model generation finishes late, and falls back on failure', async () => {
    let resolve!: (title: string) => void
    const f = fixture(undefined, { generateTitle: () => new Promise<string>(done => { resolve = done }) }), sessionId = await f.create()
    await f.prompt(sessionId)
    await f.call('session/rename', { sessionId, title: '我的标题' })
    resolve('不该覆盖')
    await vi.waitFor(() => expect(f.store.getOperation({ ownerId: 'owner', hostId: 'host', workspaceId: 'a' }, sessionId, 'automatic-title-v1')?.status).toBe('completed'))
    expect((await f.backend.catalog())[0]!.summary.projections.values.title).toBe('我的标题')
    const failed = fixture(undefined, { generateTitle: async () => { throw new Error('unavailable') } }), other = await failed.create()
    await failed.prompt(other, 'first', '备用标题')
    await vi.waitFor(() => expect(failed.store.getOperation({ ownerId: 'owner', hostId: 'host', workspaceId: 'a' }, other, 'automatic-title-v1')?.status).toBe('failed'))
    expect((await failed.backend.catalog())[0]!.summary.projections.values.title).toBe('备用标题')
  })
  it('discards a model title after the host changes accounts', async () => {
    let resolve!: (title: string) => void
    const f = fixture(undefined, { generateTitle: () => new Promise<string>(done => { resolve = done }) }), sessionId = await f.create()
    await f.prompt(sessionId)
    f.setPrincipal(undefined)
    resolve('不该写入')
    await vi.waitFor(() => expect(f.store.getOperation({ ownerId: 'owner', hostId: 'host', workspaceId: 'a' }, sessionId, 'automatic-title-v1')?.status).toBe('failed'))
    expect(f.store.getSession({ ownerId: 'owner', hostId: 'host', workspaceId: 'a' }, sessionId).title).toBe('hello')
  })

  it('keeps model-only sessions blank and names the first prompt without overwriting a rename', async () => {
    const f = fixture(), sessionId = await f.create()
    await f.call('session/selectModel', { sessionId, provider: 'codex', model: 'gpt-test' })
    const blank = (await f.backend.catalog())[0]!.summary
    expect(blank).toMatchObject({ blank: true, projections: { values: { sessionListMetadata: { blank: true, lastPromptAt: null } } } })
    f.emit({ type: 'error', code: 'MODEL_LOOKUP_FAILED', message: 'initialization diagnostic' })
    expect((await f.backend.catalog())[0]!.summary).toMatchObject({ blank: true })
    await f.prompt(sessionId, 'first', '  帮我检查\n登录接口  ')
    expect((await f.backend.catalog())[0]!.summary).toMatchObject({ blank: false, projections: { values: { title: '帮我检查 登录接口', sessionListMetadata: { blank: false } } } })
    f.emit({ type: 'turn-completed', status: 'completed' })
    const renamed = await f.call('session/rename', { sessionId, title: '我的登录问题' })
    expect(renamed.seq).toBeGreaterThan(0)
    await f.prompt(sessionId, 'second', '这条消息不能改标题')
    expect((await f.backend.catalog())[0]!.summary).toMatchObject({ projections: { values: { title: '我的登录问题' } } })
    await f.backend.close()
    const restored = fixture(f.directory)
    expect((await restored.backend.catalog())[0]!.summary).toMatchObject({ blank: false, projections: { values: { title: '我的登录问题' } } })
  })
  it('derives a title for legacy chat history and keeps renamed empty drafts blank', async () => {
    const f = fixture(), sessionId = await f.create()
    const scope = { ownerId: 'owner', hostId: 'host', workspaceId: 'a' }
    f.store.appendEvent(scope, sessionId, { eventId: 'old-message', type: 'native', payload: { type: 'user/message', data: { content: [{ type: 'text', text: '已有对话的第一条问题' }], source: { kind: 'user' } } } })
    expect((await f.backend.catalog())[0]!.summary).toMatchObject({ projections: { values: { title: '已有对话的第一条问题' } } })
    const draft = await f.create('b', 'draft')
    await f.call('session/rename', { sessionId: draft, title: '预设名字' })
    expect((await f.backend.catalog()).find(row => row.sessionId === draft)!.summary).toMatchObject({ blank: true })
    await f.prompt(draft, 'draft-message', '不能覆盖预设名字')
    expect((await f.backend.catalog()).find(row => row.sessionId === draft)!.summary).toMatchObject({ projections: { values: { title: '预设名字' } } })
  })
  it('does not dispatch a prompt revoked while its provider is starting', async () => {
    const f = fixture(), sessionId = await f.create()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const original = f.open.getMockImplementation()!
    f.open.mockImplementation(async (...args) => { await gate; return original(...args) })
    const controller = new AbortController()
    const pending = f.backend.dispatch('session/prompt', { args: { sessionId, requestId: 'revoked-start', content: [{ type: 'text', text: 'must not execute' }] } }, controller.signal)
    await vi.waitFor(() => expect(f.open).toHaveBeenCalledTimes(1))
    controller.abort()
    release()
    expect(await pending).toMatchObject({ ok: false })
    expect(f.send).not.toHaveBeenCalled()
    expect(f.store.getOperation({ ownerId: 'owner', hostId: 'host', workspaceId: 'a' }, sessionId, 'revoked-start')).toMatchObject({ status: 'failed' })
  })
  it('creates one plugin-owned session per idempotent request in its real workspace', async () => {
    const f = fixture()
    const sessionId = await f.create()
    expect(await f.create()).toBe(sessionId)
    const other = await f.create('b')
    expect(other).not.toBe(sessionId)
    expect(await f.backend.catalog()).toMatchObject([{ sessionId, workspaceId: 'a' }, { sessionId: other, workspaceId: 'b' }])
    expect(f.open).not.toHaveBeenCalled()
    f.setWorkspaces([{ workspaceId: 'a', path: '/project/a' }])
    expect(await f.backend.catalog()).toHaveLength(1)
    await expect(f.prompt(other)).rejects.toThrow('NOT_FOUND')
    f.setWorkspaces([{ workspaceId: 'a', path: '/replacement/path' }])
    expect(await f.backend.catalog()).toEqual([])
  })
  it('isolates account and host even when callers know a valid session ID', async () => {
    const f = fixture(), sessionId = await f.create()
    for (const identity of [{ ownerId: 'other', hostId: 'host' }, { ownerId: 'owner', hostId: 'other' }, undefined]) {
      f.setPrincipal(identity)
      expect(await f.backend.catalog()).toEqual([])
      await expect(f.call('session/history', { sessionId })).rejects.toThrow('NOT_FOUND')
    }
    expect(f.open).not.toHaveBeenCalled()
  })
  it('deduplicates accepted sends and rejects overlapping new turns without executing them', async () => {
    const f = fixture(), sessionId = await f.create()
    expect(await f.prompt(sessionId)).toEqual({ accepted: true })
    expect(await f.prompt(sessionId)).toEqual({ accepted: true })
    await expect(f.prompt(sessionId, 'message-2')).rejects.toThrow('BUSY')
    await expect(f.prompt(sessionId, 'message-1', 'different')).rejects.toThrow('CONFLICT')
    expect(f.open).toHaveBeenCalledTimes(1)
    expect(f.send).toHaveBeenCalledTimes(1)
    f.emit({ type: 'turn-completed', status: 'completed' })
    await f.prompt(sessionId, 'message-2')
    expect(f.send).toHaveBeenCalledTimes(2)
  })
  it('rejects a duplicate while its original send is pending and never reruns uncertain delivery', async () => {
    const f = fixture(), sessionId = await f.create()
    let resolve!: (value: ManagedAgentDispatch) => void
    f.send.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    const sending = f.prompt(sessionId)
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1))
    await expect(f.prompt(sessionId)).rejects.toThrow('UNKNOWN')
    await expect(f.prompt(sessionId, 'message-2')).rejects.toThrow('BUSY')
    resolve({ state: 'unknown', reason: 'connection lost' })
    await expect(sending).rejects.toThrow('UNKNOWN')
    await expect(f.prompt(sessionId)).rejects.toThrow('UNKNOWN')
    await expect(f.prompt(sessionId, 'new-id-after-unknown')).rejects.toThrow('BUSY')
    expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('replays messages after reconnect and closing one follow leaves task and second device alive', async () => {
    const f = fixture(), sessionId = await f.create()
    const firstSignal = new AbortController(), secondSignal = new AbortController()
    const first = (await f.backend.open('session/follow', { args: { sessionId } }, firstSignal.signal))[Symbol.asyncIterator]()
    const second = (await f.backend.open('session/follow', { args: { sessionId } }, secondSignal.signal))[Symbol.asyncIterator]()
    expect((await first.next()).value).toMatchObject({ type: 'snapshot', records: [] })
    await second.next()
    await f.prompt(sessionId)
    firstSignal.abort()
    await first.return?.()
    expect(f.cancel).not.toHaveBeenCalled()
    expect(f.close).not.toHaveBeenCalled()
    f.emit({ type: 'text', text: 'reply from running task' })
    const records = (await f.call('session/history', { sessionId })).records
    expect(records.filter((record: any) => record.event.type === 'user/message')).toHaveLength(1)
    expect(records.filter((record: any) => record.event.type === 'assistant/message')).toHaveLength(1)
    expect((await second.next()).value).toMatchObject({ type: 'event', event: { type: 'user/message' } })
    const reconnect = new AbortController()
    const resumed = (await f.backend.open('session/follow', { args: { sessionId } }, reconnect.signal))[Symbol.asyncIterator]()
    expect((await resumed.next()).value).toMatchObject({ type: 'snapshot', records })
    expect(f.open).toHaveBeenCalledTimes(1)
    secondSignal.abort(); reconnect.abort()
    await second.return?.(); await resumed.return?.()
  })
  it('restores persisted conversation on a fresh backend without replaying a completed send', async () => {
    const first = fixture(), sessionId = await first.create()
    await first.prompt(sessionId)
    first.emit({ type: 'text', text: 'durable answer' })
    first.emit({ type: 'turn-completed', status: 'completed' })
    const history = await first.call('session/history', { sessionId })
    await first.backend.close()
    const restored = fixture(first.directory)
    expect(await restored.create()).toBe(sessionId)
    expect(await restored.call('session/history', { sessionId })).toEqual(history)
    expect(await restored.prompt(sessionId)).toEqual({ accepted: true })
    expect(restored.send).not.toHaveBeenCalled()
    await restored.prompt(sessionId, 'message-after-restart')
    expect(restored.open).toHaveBeenCalledWith(expect.objectContaining({ sessionId, providerSessionId: 'provider-1' }), expect.any(Function))
  })
  it('rejects aborted calls and unauthorized session streams, and hides cached approvals after account switch', async () => {
    const f = fixture(), sessionId = await f.create()
    await f.prompt(sessionId)
    f.emit({ type: 'approval', requestId: 'approval-1', title: 'private tool', choices: ['allow-once', 'reject-once'], data: { command: 'private-command' } })
    f.setPrincipal({ ownerId: 'other', hostId: 'host' })
    await expect(f.backend.open('session/follow', { args: { sessionId } }, new AbortController().signal)).rejects.toThrow('NOT_FOUND')
    const controller = new AbortController()
    const events = (await f.backend.open('$events', {}, controller.signal))[Symbol.asyncIterator]()
    expect((await events.next()).value).toMatchObject({ type: 'ready' })
    controller.abort()
    expect((await events.next()).done).toBe(true)
    await events.return?.()
    const aborted = AbortSignal.abort()
    await expect(f.backend.open('$events', {}, aborted)).rejects.toThrow()
    expect(await f.backend.dispatch('managedAgent/create', { args: { workspaceId: 'a', agentId: 'codex', operationId: 'aborted' } }, aborted)).toMatchObject({ ok: false })
    expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('revokes one actual RPC peer while another peer continues the same durable running session', async () => {
    const f = fixture(), sessionId = await f.create()
    const trusted = new Set(['phone', 'tablet'])
    const controller = new ConnectionController({ isTrusted: (deviceId: string) => trusted.has(deviceId) } as unknown as IdentityStore,
      (_context, publish) => {
        const bridge = new HarnessRemoteBridge({
          supportsCarrier: true,
          invoke: request => f.backend.invoke(request),
          dispatch: (endpoint, payload, signal) => f.backend.dispatch(endpoint, payload, signal),
          open: (endpoint, payload, signal) => f.backend.open(endpoint, payload, signal),
          failure: () => ({ code: 'FAILED', message: 'failed', details: {} }),
        }, async (event, data) => publish(createEvent(event, data)))
        return new RpcRouter(128, undefined, undefined, bridge)
      })
    const channel = (deviceId: string, connectionId = deviceId) => {
      let handler: (message: RemoteMessage) => void = () => {}
      const output: RemoteMessage[] = []
      const value: AuthenticatedPeerChannel & { output: RemoteMessage[]; push: (message: RemoteMessage) => void } = {
        peerDeviceId: deviceId, peerIdentityKey: `key-${deviceId}`, mode: 'P2P',
        security: { protocol: 'Noise_IK_25519_ChaChaPoly_SHA256', membershipId: 'membership', connectionId },
        send: vi.fn(async message => { output.push(message) }), close: vi.fn(async () => {}),
        onMessage: next => { handler = next; return () => { handler = () => {} } },
        push: message => handler(message), output,
      }
      return value
    }
    const phone = channel('phone'), tablet = channel('tablet')
    await controller.accept(phone); await controller.accept(tablet)
    for (const peer of [phone, tablet]) {
      peer.push(createRpcRequest('harness.remote.stream.open', { streamId: `follow-${peer.peerDeviceId}`, endpoint: 'session/follow', payload: { args: { sessionId } } }))
    }
    await vi.waitFor(() => expect(phone.output.some(message => message.type === 'event')).toBe(true))
    phone.push(createRpcRequest('harness.remote.call', { endpoint: 'session/prompt', payload: { args: { sessionId, requestId: 'message-1', content: [{ type: 'text', text: 'hello' }] } } }))
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1))
    trusted.delete('phone')
    await controller.revoke('phone')
    expect(phone.close).toHaveBeenCalledWith('DEVICE_REVOKED')
    const oldCount = phone.output.length
    phone.push(createRpcRequest('harness.remote.call', { endpoint: 'session/history', payload: { args: { sessionId } } }))
    phone.push(createRpcRequest('harness.remote.call', { endpoint: 'session/prompt', payload: { args: { sessionId, requestId: 'forbidden', content: [{ type: 'text', text: 'must not execute' }] } } }))
    await expect(controller.accept(channel('phone', 'phone-new'))).rejects.toThrow()
    f.emit({ type: 'text', text: 'still running for tablet' })
    await vi.waitFor(() => expect(JSON.stringify(tablet.output)).toContain('still running for tablet'))
    expect(phone.output).toHaveLength(oldCount)
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.close).not.toHaveBeenCalled(); expect(f.cancel).not.toHaveBeenCalled()
    expect(controller.peerDeviceIds()).toEqual(['tablet'])
    await controller.close()
  })

  it('does not reattribute an in-flight create to an account switched during workspace lookup', async () => {
    const f = fixture()
    let release!: (rows: { workspaceId: string; path: string }[]) => void
    f.setWorkspaceResolver(() => new Promise(resolve => { release = resolve }))
    const creation = f.create()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    f.setPrincipal({ ownerId: 'other-owner', hostId: 'host' })
    release([{ workspaceId: 'a', path: '/project/a' }])
    await expect(creation).rejects.toThrow()
    expect(f.store.listSessions({ ownerId: 'other-owner', hostId: 'host', workspaceId: 'a' })).toEqual([])
  })
  it('does not reveal a new account projection through an old account control stream', async () => {
    const f = fixture()
    const controller = new AbortController()
    const stream = (await f.backend.open('session/control', {}, controller.signal))[Symbol.asyncIterator]()
    await stream.next()
    f.setPrincipal({ ownerId: 'other-owner', hostId: 'host' })
    const sessionId = await f.create()
    await f.prompt(sessionId)
    controller.abort()
    const next = await stream.next()
    expect(next.done).toBe(true)
    await stream.return?.()
  })
  it('keeps an unresolved send blocked across backend restart even under a different operation ID', async () => {
    const original = fixture(), sessionId = await original.create()
    await original.prompt(sessionId)
    original.emit({ type: 'turn-completed', status: 'completed' })
    original.send.mockResolvedValueOnce({ state: 'unknown', reason: 'lost provider receipt' })
    await expect(original.prompt(sessionId, 'uncertain-2')).rejects.toThrow('UNKNOWN')
    await original.backend.close()
    const recovered = fixture(original.directory)
    await expect(recovered.prompt(sessionId, 'new-id-after-restart')).rejects.toThrow(/BUSY|UNKNOWN|UNCERTAIN/)
    expect(recovered.send).not.toHaveBeenCalled()
  })

  it('uses only advertised models/efforts and restores a selected model on provider resume', async () => {
    const f = fixture(), sessionId = await f.create()
    const request = { sessionId, provider: 'codex', model: 'gpt-test', reasoningEffort: 'high' }
    await expect(f.call('session/selectModel', { ...request, model: 'invented-model' })).rejects.toThrow('MODEL_UNAVAILABLE')
    await expect(f.call('session/selectModel', { ...request, reasoningEffort: 'invented-effort' })).rejects.toThrow('REASONING_UNAVAILABLE')
    expect(f.setOption).not.toHaveBeenCalled()
    expect(await f.call('session/selectModel', request)).toEqual({ selected: { provider: 'codex', model: 'gpt-test', reasoningEffort: 'high' } })
    expect(f.setOption.mock.calls).toEqual([['model', 'gpt-test'], ['reasoningEffort', 'high']])
    await f.backend.close()
    const restored = fixture(f.directory)
    expect(await restored.call('session/initializeDefaultModel', { sessionId })).toEqual({ selected: { provider: 'codex', model: 'gpt-test', reasoningEffort: 'high' } })
    await restored.prompt(sessionId)
    expect(restored.open).toHaveBeenCalledWith(expect.objectContaining({ providerSessionId: 'provider-1', model: 'gpt-test', reasoningEffort: 'high' }), expect.any(Function))
  })
  it('prevents a new turn while an asynchronous model selection is being applied', async () => {
    const f = fixture(), sessionId = await f.create()
    let finish!: () => void
    f.setOption.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const selecting = f.call('session/selectModel', { sessionId, provider: 'codex', model: 'gpt-test' })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await expect(f.prompt(sessionId)).rejects.toThrow('BUSY')
    expect(f.send).not.toHaveBeenCalled()
    finish()
    await selecting
    await f.prompt(sessionId)
    expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('does not return a private model catalog after account switch during provider query', async () => {
    const f = fixture(), sessionId = await f.create()
    let finish!: (value: unknown) => void
    f.models.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const querying = f.call('session/models', { sessionId })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    f.setPrincipal({ ownerId: 'new-owner', hostId: 'host' })
    finish({ data: [{ model: 'private-model' }] })
    await expect(querying).rejects.toThrow('AUTH_CHANGED')
    expect(f.send).not.toHaveBeenCalled()
  })

  it('recovers an unavailable provider using its durable session identity rather than a dead cached connection', async () => {
    const f = fixture(), sessionId = await f.create()
    await f.prompt(sessionId)
    f.emit({ type: 'turn-completed', status: 'completed' })
    f.emit({ type: 'unavailable', code: 'PROCESS_EXITED' })
    expect(f.close).toHaveBeenCalledTimes(1)
    await f.prompt(sessionId, 'after-process-exit')
    expect(f.open).toHaveBeenCalledTimes(2)
    expect(f.open.mock.calls[1]?.[0]).toMatchObject({ sessionId, providerSessionId: 'provider-1' })
    expect(f.send).toHaveBeenCalledTimes(2)
    expect(await f.create()).toBe(sessionId)
  })

  it('ignores late provider events from a retired runtime generation', async () => {
    const f = fixture(), sessionId = await f.create()
    await f.prompt(sessionId)
    const retiredEmit = f.captureEmitter()
    f.emit({ type: 'turn-completed', status: 'completed' })
    f.emit({ type: 'unavailable', code: 'PROCESS_EXITED' })
    await f.prompt(sessionId, 'replacement-turn')
    retiredEmit({ type: 'text', text: 'stale generation secret' })
    retiredEmit({ type: 'turn-completed', status: 'completed' })
    retiredEmit({ type: 'unavailable', code: 'LATE_EXIT' })
    expect(JSON.stringify(await f.call('session/history', { sessionId }))).not.toContain('stale generation secret')
    await expect(f.prompt(sessionId, 'must-stay-busy')).rejects.toThrow('BUSY')
    expect(f.close).toHaveBeenCalledTimes(1)
    f.emit({ type: 'turn-completed', status: 'completed' })
    await f.prompt(sessionId, 'third-turn')
    expect(f.open).toHaveBeenCalledTimes(2)
  })

  it('persists provably undelivered rejection, ends the turn, and permits only a new operation retry', async () => {
    const f = fixture(), sessionId = await f.create()
    f.send.mockResolvedValueOnce({ state: 'rejected', reason: 'input was provably unwritten' })
    await expect(f.prompt(sessionId)).rejects.toThrow('MANAGED_SEND_REJECTED')
    expect(f.store.getOperation({ ownerId: 'owner', hostId: 'host', workspaceId: 'a' }, sessionId, 'message-1')).toMatchObject({ status: 'failed', result: { code: 'MANAGED_SEND_REJECTED' } })
    const history = await f.call('session/history', { sessionId })
    expect(history.records.at(-1)).toMatchObject({ event: { type: 'turn/end', data: { reason: { kind: 'error' } } } })
    await expect(f.prompt(sessionId)).rejects.toThrow('MANAGED_SEND_REJECTED')
    expect(f.send).toHaveBeenCalledTimes(1)
    await f.backend.close()
    const restored = fixture(f.directory)
    await expect(restored.prompt(sessionId)).rejects.toThrow('MANAGED_SEND_REJECTED')
    expect(restored.send).not.toHaveBeenCalled()
    await restored.prompt(sessionId, 'explicit-new-retry')
    expect(restored.send).toHaveBeenCalledTimes(1)
  })

})
