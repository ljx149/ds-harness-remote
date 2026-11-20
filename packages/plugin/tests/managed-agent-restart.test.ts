import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { ManagedSessionStore } from '../src/managed-session-store/index.js'
import { ManagedAgentBackend } from '../src/managed-agent-backend.js'
import { ManagedAgentRuntime } from '../src/managed-agents/runtime.js'
import { ManagedAgentRegistry } from '../src/managed-agents/registry.js'
import { installManagedAgentGateway } from '../src/managed-agent-gateway.js'
import { AsyncValueQueue } from '../src/codex/virtual-contract.js'

it('restores persisted CC/Codex sidebar after delayed authentication without a new message or page reload', async () => {
  vi.useFakeTimers()
  const directory = mkdtempSync(join(tmpdir(), 'managed-restart-'))
  const scope = { ownerId: 'account-a', hostId: 'device-a', workspaceId: 'workspace-a' }
  const initial = ManagedSessionStore.open(directory)
  const ids = ['claude', 'codex'].map(agentId => {
    const session = initial.createSession(scope, { operationId: agentId, agentId, providerId: agentId, workspacePath: '/project/a' })
    initial.bindProviderSession(scope, session.id, `provider-${agentId}`)
    initial.appendEvent(scope, session.id, { eventId: `message-${agentId}`, type: 'user/message', payload: { type: 'user/message', data: { content: [{ type: 'text', text: 'saved prompt' }] } } })
    return session.id
  })
  initial.close()
  const store = ManagedSessionStore.open(directory)
  let principal: { ownerId: string; hostId: string } | undefined
  const backend = new ManagedAgentBackend(store, new ManagedAgentRuntime(new ManagedAgentRegistry([])), () => principal, async () => [{ workspaceId: scope.workspaceId, path: '/project/a' }])
  const lifetime = new AbortController()
  const source = new AsyncValueQueue(lifetime.signal)
  const gateway = { invoke: async (_request: any): Promise<any> => undefined, stream: async (_request: any): Promise<AsyncIterable<unknown>> => source }
  const undo = installManagedAgentGateway(gateway, backend)
  let iterator: AsyncIterator<unknown> | undefined
  try {
    const stream = await gateway.stream({ namespace: 'workspace', method: 'follow', args: {}, signal: lifetime.signal, peer: { principal: { kind: 'owner' }, signal: lifetime.signal } })
    iterator = stream[Symbol.asyncIterator]()
    source.push({ type: 'baseline', value: { items: [{ workspaceId: scope.workspaceId, sessionIds: ['native'] }] } })
    expect((await iterator.next()).value).toMatchObject({ value: { items: [{ sessionIds: ['native'] }] } })
    principal = scope
    const restored = iterator.next()
    await vi.advanceTimersByTimeAsync(1000)
    expect((await restored).value).toMatchObject({ type: 'replace', value: { items: [{ sessionIds: ['native', ...ids] }] } })
    expect(store.getSession(scope, ids[0]!).providerSessionId).toBe('provider-claude')
    expect(store.readEvents(scope, ids[0]!, 0, 10).events).toHaveLength(1)
    const hidden = iterator.next()
    principal = { ownerId: 'another-account', hostId: scope.hostId }
    await vi.advanceTimersByTimeAsync(1000)
    expect((await hidden).value).toMatchObject({ value: { items: [{ sessionIds: ['native'] }] } })
    expect(await backend.catalog()).toEqual([])
    principal = scope
    const again = iterator.next()
    await vi.advanceTimersByTimeAsync(1000)
    expect((await again).value).toMatchObject({ value: { items: [{ sessionIds: ['native', ...ids] }] } })
    const loggedOut = iterator.next()
    principal = undefined
    await vi.advanceTimersByTimeAsync(1000)
    expect((await loggedOut).value).toMatchObject({ value: { items: [{ sessionIds: ['native'] }] } })
  } finally {
    lifetime.abort(); await iterator?.return?.(); undo(); await backend.close()
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers(); rmSync(directory, { recursive: true, force: true })
  }
})
