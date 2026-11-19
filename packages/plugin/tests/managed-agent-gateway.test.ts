import { describe, expect, it, vi } from 'vitest'
import { installManagedAgentGateway, mergeManagedWorkspaces, type ManagedAgentNativeBackend } from '../src/managed-agent-gateway.js'
import { AsyncValueQueue } from '../src/codex/virtual-contract.js'
import type { TypertGatewayLike, TypertRpcResult } from '../src/typert-gateway-contract.js'

const owner = () => ({ principal: { kind: 'owner' }, signal: new AbortController().signal })
const entries = [{ sessionId: 'managed:1', workspaceId: 'w1', agentId: 'codex', summary: { sessionId: 'managed:1' } }]
function backend(): ManagedAgentNativeBackend {
  return {
    ownsSession: id => id === 'managed:1', catalog: async () => entries, subscribeCatalog: () => () => {},
    invoke: vi.fn(async () => 'managed'), dispatch: vi.fn(async () => ({ ok: true as const, value: 'managed' })),
    open: vi.fn(async () => ({ async *[Symbol.asyncIterator]() {} })),
  }
}
describe('managed Agent native gateway authority', () => {
  it('resolves persisted membership before a phone resumes without listing after Host restart', async () => {
    const agent = backend()
    let loaded = false
    agent.ownsSession = id => loaded && id === 'managed:1'
    const catalog = vi.fn(async () => { loaded = true; return entries })
    agent.catalog = catalog
    const native = vi.fn(async (_request?: unknown) => 'native')
    const wire = { invoke: native, openWireStream: async (_endpoint: string, _payload: unknown, _uplink: unknown, _peer: unknown, _signal: AbortSignal) => ({ async *[Symbol.asyncIterator]() {} }) }
    const undo = installManagedAgentGateway(wire, agent)
    await wire.openWireStream('session/follow', { args: { sessionId: 'managed:1' } }, {}, owner(), new AbortController().signal)
    expect(agent.open).toHaveBeenCalledTimes(1)
    expect(catalog).toHaveBeenCalledTimes(1)
    loaded = false
    expect(await wire.invoke({ namespace: 'session', method: 'projections', args: { sessionId: 'managed:1' }, peer: owner() } as never)).toBe('managed')
    expect(native).not.toHaveBeenCalled()
    loaded = false; catalog.mockClear()
    await wire.invoke({ namespace: 'session', method: 'projections', args: { sessionId: 'managed:1' }, peer: { principal: { kind: 'guest' } } } as never)
    expect(catalog).not.toHaveBeenCalled()
    undo()
  })

  it('unions native and managed archive sets in snapshots and native mutations', async () => {
    const agent = backend()
    agent.catalog = async () => entries.map(entry => ({ ...entry, archived: true }))
    expect(mergeManagedWorkspaces({ items: [], archivedSessionIds: ['native'] }, await agent.catalog(new AbortController().signal))).toMatchObject({ archivedSessionIds: ['native', 'managed:1'] })
    const gateway = { invoke: vi.fn(async (_request: any): Promise<any> => ({ archivedSessionIds: ['native'] })) }
    const dispose = installManagedAgentGateway(gateway, agent)
    const result = await gateway.invoke({ namespace: 'workspace', method: 'archiveSession', args: { sessionId: 'native' }, peer: owner(), signal: new AbortController().signal } as any)
    expect(result).toEqual({ archivedSessionIds: ['native', 'managed:1'] })
    dispose()
  })

  it('merges registry membership only into its exact existing workspace without mutating native data', () => {
    const original = { items: [{ workspaceId: 'w1', sessionIds: ['dsh1'] }, { workspaceId: 'w2', sessionIds: ['dsh2'] }] }
    expect(mergeManagedWorkspaces(original, [...entries, { ...entries[0]!, sessionId: 'orphan', workspaceId: 'missing' }])).toEqual({ items: [
      { workspaceId: 'w1', sessionIds: ['dsh1', 'managed:1'] }, { workspaceId: 'w2', sessionIds: ['dsh2'] },
    ], archivedSessionIds: [] })
    expect(original.items[0]!.sessionIds).toEqual(['dsh1'])
  })
  it('preserves native dispatch peer and uplink while routing only registry-owned sessions', async () => {
    const agent = backend()
    const peer = owner()
    const invoke = vi.fn(async () => 'native')
    const dispatchRpc = vi.fn(async (): Promise<TypertRpcResult> => ({ ok: true, value: 'native' }))
    const gateway: TypertGatewayLike & { dispatchRpc: (...args: unknown[]) => Promise<TypertRpcResult> } = { invoke, dispatchRpc }
    const dispose = installManagedAgentGateway(gateway, agent)
    const signal = new AbortController().signal
    const payload = { args: { request: { sessionId: 'dsh1', content: [] } } }
    await gateway.dispatchRpc('session/prompt', payload, signal, peer)
    expect(dispatchRpc).toHaveBeenLastCalledWith('session/prompt', payload, signal, peer)
    expect(await gateway.invoke({ namespace: 'session', method: 'prompt', args: { request: { sessionId: 'managed:1' } }, peer })).toBe('managed')
    expect(await gateway.invoke({ namespace: 'session', method: 'prompt', args: { request: { sessionId: 'managed:spoof' } }, peer })).toBe('native')
    dispose()
    expect(gateway.invoke).toBe(invoke)
    expect(gateway.dispatchRpc).toBe(dispatchRpc)
  })
  it('merges list results without replacing native entries', async () => {
    const gateway = { invoke: async () => ({ items: [{ sessionId: 'dsh1' }] }) } as TypertGatewayLike
    const dispose = installManagedAgentGateway(gateway, backend())
    expect(await gateway.invoke({ namespace: 'session', method: 'list', args: {}, peer: owner() })).toEqual({ items: [{ sessionId: 'dsh1' }, { sessionId: 'managed:1' }] })
    dispose()
  })
  it('preserves rc1 carrier arity and refreshes managed membership with replace frames', async () => {
    const lifetime = new AbortController()
    const source = new AsyncValueQueue(lifetime.signal)
    let changed = () => {}
    const agent = backend()
    agent.subscribeCatalog = listener => { changed = listener; return () => {} }
    let received: unknown[] = []
    async function openWireStream(endpoint: string, payload: unknown, uplink: unknown, peer: unknown, signal: AbortSignal, control: unknown): Promise<AsyncIterable<unknown>> {
      received = [endpoint, payload, uplink, peer, signal, control]
      return source
    }
    const gateway: TypertGatewayLike & { openWireStream: typeof openWireStream } = { invoke: async () => undefined, openWireStream }
    const dispose = installManagedAgentGateway(gateway, agent)
    expect(gateway.openWireStream.length).toBe(6)
    const peer = owner(), uplink = {}, control = {}
    const result = await gateway.openWireStream('workspace/follow', { args: {} }, uplink, peer, lifetime.signal, control)
    source.push({ type: 'baseline', value: { items: [{ workspaceId: 'w1', sessionIds: ['dsh1'] }], archivedSessionIds: [], pinnedSessionIds: [] } })
    const iterator = result[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toMatchObject({ type: 'baseline', value: { items: [{ sessionIds: ['dsh1', 'managed:1'] }] } })
    expect(received[2]).toBe(uplink)
    expect(received[3]).toBe(peer)
    expect(received[5]).toBe(control)
    agent.catalog = async () => entries.map(entry => ({ ...entry, archived: true }))
    source.push({ type: 'archived', archivedSessionIds: ['native-archived'] })
    expect((await iterator.next()).value).toEqual({ type: 'archived', archivedSessionIds: ['native-archived', 'managed:1'] })
    changed()
    expect((await iterator.next()).value).toMatchObject({ type: 'replace', value: { items: [{ sessionIds: ['dsh1', 'managed:1'] }] } })
    lifetime.abort()
    await iterator.return?.()
    dispose()
  })

  it('denies unknown or disposed peers and does not leak catalog to native grants', async () => {
    const agent = backend()
    const gateway: TypertGatewayLike = { invoke: async () => ({ items: [{ sessionId: 'dsh1' }] }) }
    const dispose = installManagedAgentGateway(gateway, agent)
    for (const peer of [undefined, { principal: { kind: 'grant' }, signal: new AbortController().signal }, { principal: { kind: 'owner' }, signal: AbortSignal.abort() }]) {
      await expect(gateway.invoke({ namespace: 'managedAgent', method: 'create', args: {}, peer })).rejects.toMatchObject({ code: 'remote-access/denied' })
      expect(await gateway.invoke({ namespace: 'session', method: 'list', args: {}, peer })).toEqual({ items: [{ sessionId: 'dsh1' }] })
    }
    expect(agent.invoke).not.toHaveBeenCalled()
    dispose()
  })

  it('merges owner global model catalog while preserving native default and native model definitions', async () => {
    const agent = backend()
    agent.managedModelCatalog = vi.fn(async () => ({ groups: [{ id: 'codex', models: [{ id: 'gpt-local' }] }], routableProviders: ['codex'], failures: [], default: { provider: 'codex', model: 'gpt-local' } }))
    const native = { default: { provider: 'dsh', model: 'native-default' }, groups: [{ id: 'dsh', models: [{ id: 'native-default' }] }], routableProviders: ['dsh'], failures: [{ id: 'offline', message: 'offline' }] }
    const gateway: TypertGatewayLike = { invoke: async () => native }
    const dispose = installManagedAgentGateway(gateway, agent)
    const result = await gateway.invoke({ namespace: 'session', method: 'modelCatalog', args: {}, peer: owner() }) as typeof native
    expect(result.default).toEqual(native.default)
    expect(result.groups).toEqual([...native.groups, { id: 'codex', models: [{ id: 'gpt-local' }] }])
    expect(result.routableProviders).toEqual(['dsh', 'codex'])
    expect(result.failures).toEqual(native.failures)
    expect(await gateway.invoke({ namespace: 'session', method: 'modelCatalog', args: {}, peer: { principal: { kind: 'grant' }, signal: new AbortController().signal } })).toBe(native)
    expect(agent.managedModelCatalog).toHaveBeenCalledTimes(1)
    expect(native.groups).toHaveLength(1)
    dispose()
  })
  it('offers usable managed catalog after native failure while exposing a safe failure indication', async () => {
    const agent = backend()
    const local = { groups: [{ id: 'codex', models: [{ id: 'gpt-local' }] }], routableProviders: ['codex'], failures: [], default: { provider: 'codex', model: 'gpt-local' } }
    agent.managedModelCatalog = vi.fn(async () => local)
    const failure = new Error('private-path-and-token-must-not-leak')
    const gateway: TypertGatewayLike & { dispatchRpc: (...args: any[]) => Promise<TypertRpcResult> } = {
      invoke: async () => { throw failure }, dispatchRpc: async () => ({ ok: false, error: { code: 'FAILED', message: failure.message, details: {} } }),
    }
    const dispose = installManagedAgentGateway(gateway, agent)
    const value = await gateway.invoke({ namespace: 'session', method: 'modelCatalog', args: {}, peer: owner() })
    expect(value).toMatchObject({ default: local.default, groups: local.groups, failures: [{ id: 'native' }] })
    expect(JSON.stringify(value)).not.toContain(failure.message)
    expect(await gateway.dispatchRpc('session/modelCatalog', { args: {} }, new AbortController().signal, owner())).toMatchObject({ ok: true, value: { groups: local.groups, failures: [{ id: 'native' }] } })
    agent.managedModelCatalog = async () => ({ groups: [], routableProviders: [], failures: [] })
    await expect(gateway.invoke({ namespace: 'session', method: 'modelCatalog', args: {}, peer: owner() })).rejects.toBe(failure)
    dispose()
  })
  it('notifies model refresh only when managed session membership changes, not on each message', async () => {
    const agent = backend()
    let current = [...entries], changed = () => {}
    agent.catalog = async () => current
    agent.subscribeCatalog = callback => { changed = callback; return () => {} }
    const events: any[] = []
    const secondLifetime = new AbortController(), secondSource = new AsyncValueQueue(secondLifetime.signal)
    const wire = { invoke: async () => undefined, openWireStream: async (_endpoint: string, _payload: unknown, _uplink: unknown, _peer: unknown, _signal: AbortSignal) => secondSource as AsyncIterable<unknown> }
    const undo = installManagedAgentGateway(wire, agent)
    const mapped = await wire.openWireStream('$events', { args: {} }, {}, owner(), secondLifetime.signal)
    const collecting = (async () => { for await (const event of mapped) events.push(event) })()
    changed()
    await vi.waitFor(() => expect(events.some(event => event.event === 'api-session/added')).toBe(true))
    expect(events.filter(event => event.event === 'llm/models-updated')).toHaveLength(0)
    current = [...current, { ...entries[0]!, sessionId: 'managed:2' }]
    changed()
    await vi.waitFor(() => expect(events.filter(event => event.event === 'llm/models-updated')).toHaveLength(1))
    const previousAdded = events.filter(event => event.event === 'api-session/added').length
    changed()
    await vi.waitFor(() => expect(events.filter(event => event.event === 'api-session/added').length).toBeGreaterThan(previousAdded))
    expect(events.filter(event => event.event === 'llm/models-updated')).toHaveLength(1)
    secondLifetime.abort(); await collecting; undo()
  })

})
