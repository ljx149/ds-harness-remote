import { AsyncValueQueue } from './codex/virtual-contract.js'
import type { RemoteTypertGatewayTarget, TypertGatewayLike, TypertRpcResult } from './typert-gateway-contract.js'

export interface ManagedAgentCatalogEntry {
  sessionId: string
  workspaceId: string
  agentId: string
  archived?: boolean
  summary: Record<string, unknown>
}
export interface ManagedAgentNativeBackend extends RemoteTypertGatewayTarget {
  ownsSession(id: string): boolean
  catalog(signal: AbortSignal): Promise<readonly ManagedAgentCatalogEntry[]>
  subscribeCatalog(listener: () => void): () => void
  managedModelCatalog?(signal: AbortSignal): Promise<{ groups: readonly Record<string, unknown>[]; routableProviders: readonly string[]; failures: readonly Record<string, unknown>[]; default?: unknown }>
}

type Row = Record<string, unknown>
const row = (value: unknown): Row | undefined => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Row : undefined
const argsOf = (payload: unknown): Row => row(row(payload)?.args) ?? {}
const requestOf = (payload: unknown): Row => row(argsOf(payload).request) ?? argsOf(payload)

function isLiveOwner(peer: unknown): boolean {
  const value = row(peer)
  return row(value?.principal)?.kind === 'owner' && value?.signal instanceof AbortSignal && !value.signal.aborted
}
function ownerDenied(): Error {
  return Object.assign(new Error('Managed Agent sessions require a live owner peer.'), { code: 'remote-access/denied', isDSHRemoteError: true, details: {} })
}
function ownerSignal(signal: AbortSignal, peer: unknown): AbortSignal {
  return AbortSignal.any([signal, (peer as { signal: AbortSignal }).signal])
}

/** Only the plugin registry confers ownership; a matching-looking ID is not authority. */
export function managedAgentOwnsRequest(backend: ManagedAgentNativeBackend, endpoint: string, payload: unknown): boolean {
  if (endpoint.startsWith('managedAgent/')) return true
  if (endpoint === '$events/result') return typeof argsOf(payload).eventId === 'string' && (argsOf(payload).eventId as string).startsWith('managed-agent:')
  const request = requestOf(payload)
  const id = request.sessionId ?? row(request.address)?.sessionId ?? row(request.address)?.id
  return typeof id === 'string' && backend.ownsSession(id)
    && (endpoint.startsWith('session/') || endpoint.startsWith('workspace/'))
}

/** Native create may name a blank from the merged list. Managed blanks are
 * not native drafts: decline only that reuse hint, preserving native validation,
 * workspace/preset selection and the original caller's authority. */
function withoutManagedBlank(args: unknown): Row {
  const outer = row(args) ?? {}
  const nested = row(outer.request)
  const { sessionId: _ignored, ...request } = nested ?? outer
  return nested ? { ...outer, request } : request
}

/** Merge membership into existing native workspaces; never invent a workspace or import Agent history. */
export function mergeManagedWorkspaces(value: unknown, entries: readonly ManagedAgentCatalogEntry[]): unknown {
  const source = row(value)
  if (!source || !Array.isArray(source.items)) return value
  return { ...source, archivedSessionIds: [...new Set([...(Array.isArray(source.archivedSessionIds) ? source.archivedSessionIds : []), ...entries.filter(entry => entry.archived).map(entry => entry.sessionId)])], items: source.items.map(item => {
    const workspace = row(item)
    if (!workspace || typeof workspace.workspaceId !== 'string' || !Array.isArray(workspace.sessionIds)) return item
    return { ...workspace, sessionIds: [...new Set([...workspace.sessionIds, ...entries.filter(entry => entry.workspaceId === workspace.workspaceId).map(entry => entry.sessionId)])] }
  }) }
}
function mergeSessions(value: unknown, entries: readonly ManagedAgentCatalogEntry[]): unknown {
  const source = row(value)
  if (!source || !Array.isArray(source.items)) return value
  const nativeIds = new Set(source.items.map(item => row(item)?.sessionId))
  return { ...source, items: [...source.items, ...entries.filter(entry => !nativeIds.has(entry.sessionId)).map(entry => entry.summary)] }
}
function mergeBusiness(result: TypertRpcResult, endpoint: string, entries: readonly ManagedAgentCatalogEntry[]): TypertRpcResult {
  if (!result.ok) return result
  if (endpoint === 'workspace/archiveSession' || endpoint === 'workspace/unarchiveSession') {
    const value = row(result.value) ?? {}
    return { ...result, value: { ...value, archivedSessionIds: [...new Set([...(Array.isArray(value.archivedSessionIds) ? value.archivedSessionIds : []), ...entries.filter(entry => entry.archived).map(entry => entry.sessionId)])] } }
  }
  return { ...result, value: endpoint === 'workspace/list' ? mergeManagedWorkspaces(result.value, entries) : mergeSessions(result.value, entries) }
}

function globalModelCatalog(endpoint: string, payload: unknown): boolean {
  const request = requestOf(payload)
  return endpoint === 'session/modelCatalog' && request.sessionId === undefined && request.address === undefined
}
async function mergeModels(result: TypertRpcResult, backend: ManagedAgentNativeBackend, signal: AbortSignal): Promise<TypertRpcResult> {
  if (!backend.managedModelCatalog) return result
  const extra = await backend.managedModelCatalog(signal)
  signal.throwIfAborted()
  if (!result.ok && !extra.groups.length) return result
  const native = result.ok ? row(result.value) ?? {} : {}
  const groups: Row[] = (Array.isArray(native.groups) ? native.groups : []).flatMap(value => row(value) ? [{ ...row(value)! }] : [])
  for (const group of extra.groups) {
    const existing = groups.find(value => value.id === group.id)
    if (!existing) groups.push({ ...group })
    else if (Array.isArray(existing.models) && Array.isArray(group.models)) {
      const ids = new Set(existing.models.map(value => row(value)?.id))
      existing.models = [...existing.models, ...group.models.filter(value => !ids.has(row(value)?.id))]
    }
  }
  return { ok: true, value: { ...native,
    ...(native.default === undefined && extra.default !== undefined ? { default: extra.default } : {}),
    groups,
    routableProviders: [...new Set([...(Array.isArray(native.routableProviders) ? native.routableProviders : []), ...extra.routableProviders])],
    failures: [...(Array.isArray(native.failures) ? native.failures : []), ...extra.failures,
      ...(!result.ok ? [{ id: 'native', name: 'DSH', message: 'The native DSH model catalog is unavailable.' }] : [])],
  } }
}

/** Install before TypertGatewaySwitch captures its local face. Native calls keep their original peer/uplink. */
export function installManagedAgentGateway(gateway: TypertGatewayLike, backend: ManagedAgentNativeBackend): () => void {
  type Runtime = TypertGatewayLike & { dispatchRpc?: (...args: any[]) => Promise<TypertRpcResult>; openWireStream?: (...args: any[]) => Promise<AsyncIterable<unknown>> }
  const runtime = gateway as Runtime
  const invoke = runtime.invoke
  const dispatch = runtime.dispatchRpc
  const stream = runtime.stream
  const open = runtime.openWireStream
  // A phone may resume directly after Host restart without listing sessions first.
  // Resolve persisted membership for trusted callers before deciding native vs managed.
  const owns = async (endpoint: string, payload: unknown, signal: AbortSignal, peer: unknown) => {
    if (managedAgentOwnsRequest(backend, endpoint, payload)) return true
    const request = requestOf(payload)
    const id = request.sessionId ?? row(request.address)?.sessionId ?? row(request.address)?.id
    if (isLiveOwner(peer) && typeof id === 'string' && (endpoint.startsWith('session/') || endpoint.startsWith('workspace/'))) {
      await backend.catalog(ownerSignal(signal, peer))
      return managedAgentOwnsRequest(backend, endpoint, payload)
    }
    return false
  }
  const merge = async (endpoint: string, result: TypertRpcResult, signal: AbortSignal, payload: unknown) => globalModelCatalog(endpoint, payload)
    ? mergeModels(result, backend, signal) : ['session/list', 'workspace/list', 'workspace/archiveSession', 'workspace/unarchiveSession'].includes(endpoint)
    ? mergeBusiness(result, endpoint, await backend.catalog(signal)) : result
  runtime.invoke = async request => {
    const endpoint = `${request.namespace}/${request.method}`
    if (await owns(endpoint, { args: request.args }, request.signal ?? new AbortController().signal, request.peer)) {
      if (!isLiveOwner(request.peer)) throw ownerDenied()
      if (endpoint === 'session/create') request = { ...request, args: withoutManagedBlank(request.args) }
      else return backend.invoke({ ...request, signal: ownerSignal(request.signal ?? new AbortController().signal, request.peer) })
    }
    let value: unknown
    try { value = await invoke.call(runtime, request) }
    catch (error) {
      if (isLiveOwner(request.peer) && globalModelCatalog(endpoint, { args: request.args })) {
        const fallback = await mergeModels({ ok: false, error: { code: 'native-model-catalog/unavailable', message: 'Native catalog unavailable.', details: {} } }, backend, ownerSignal(request.signal ?? new AbortController().signal, request.peer))
        if (fallback.ok) return fallback.value
      }
      throw error
    }
    if (!isLiveOwner(request.peer)) return value
    const result = await merge(endpoint, { ok: true, value }, ownerSignal(request.signal ?? new AbortController().signal, request.peer), { args: request.args })
    return result.ok ? result.value : value
  }
  if (dispatch) runtime.dispatchRpc = async (...args) => {
    const [endpoint, payload, signal] = args as [string, unknown, AbortSignal]
    const peer = args[3]
    if (await owns(endpoint, payload, signal, peer)) {
      if (!isLiveOwner(peer)) return { ok: false, error: { code: 'remote-access/denied', message: ownerDenied().message, details: {} } }
      if (endpoint === 'session/create') args[1] = { ...row(payload), args: withoutManagedBlank(argsOf(payload)) }
      else return backend.dispatch(endpoint, payload, ownerSignal(signal, peer))
    }
    const result = await dispatch.apply(runtime, args)
    return isLiveOwner(peer) ? merge(endpoint, result, ownerSignal(signal, peer), payload) : result
  }
  const mapStream = async (endpoint: string, openSource: (signal: AbortSignal) => Promise<AsyncIterable<unknown>>, signal: AbortSignal): Promise<AsyncIterable<unknown>> => {
    if (!['workspace/follow', '$events', 'session/control'].includes(endpoint)) return openSource(signal)
    const queue = new AsyncValueQueue(signal)
    const lifetime = new AbortController()
    const combined = AbortSignal.any([signal, lifetime.signal])
    let nativeWorkspace: Row | undefined
    let knownManagedIds = new Set((await backend.catalog(combined)).map(entry => entry.sessionId))
    let refresh: Promise<void> = Promise.resolve()
    const unsubscribe = backend.subscribeCatalog(() => {
      refresh = refresh.then(async () => {
        if (combined.aborted) return
        const entries = await backend.catalog(combined)
        if (endpoint === 'workspace/follow' && nativeWorkspace) queue.push({ type: 'replace', value: mergeManagedWorkspaces(nativeWorkspace, entries) })
        if (endpoint === '$events') {
          const currentIds = new Set(entries.map(entry => entry.sessionId))
          const membershipChanged = currentIds.size !== knownManagedIds.size || [...currentIds].some(id => !knownManagedIds.has(id))
          for (const id of knownManagedIds) if (!currentIds.has(id)) queue.push({ type: 'emit', event: 'api-session/removed', args: [id] })
          for (const entry of entries) {
            queue.push({ type: 'emit', event: 'api-session/added', args: [entry.summary] })
            // Native DSH does not update an attached Session's running flag
            // from added summaries. Explicit status is required after a turn.
            queue.push({ type: 'emit', event: 'api-session/status', args: [entry.sessionId, entry.summary.running === true] })
          }
          if (membershipChanged) queue.push({ type: 'emit', event: 'llm/models-updated', args: ['xcodex-remote'] })
          knownManagedIds = currentIds
        }
      }).catch(() => { lifetime.abort(); queue.close() })
    })
    void (async () => {
      try {
        for await (const frame of await openSource(combined)) {
          if (combined.aborted) break
          const item = row(frame)
          if (endpoint === 'workspace/follow' && (item?.type === 'baseline' || item?.type === 'replace')) {
            nativeWorkspace = row(item.value)
            queue.push({ ...item, value: mergeManagedWorkspaces(item.value, await backend.catalog(combined)) })
          } else if (endpoint === 'workspace/follow' && item?.type === 'upsert') {
            const workspace = row(item.workspace)
            if (nativeWorkspace && Array.isArray(nativeWorkspace.items) && workspace) {
              nativeWorkspace = { ...nativeWorkspace, items: [...nativeWorkspace.items.filter(value => row(value)?.workspaceId !== workspace.workspaceId), workspace] }
            }
            const merged = row(mergeManagedWorkspaces({ items: [item.workspace] }, await backend.catalog(combined)))
            queue.push({ ...item, workspace: (merged?.items as unknown[])[0] })
          } else {
            if (endpoint === 'workspace/follow' && item?.type === 'remove' && nativeWorkspace && Array.isArray(nativeWorkspace.items)) nativeWorkspace = { ...nativeWorkspace, items: nativeWorkspace.items.filter(value => row(value)?.workspaceId !== item.workspaceId) }
            if (endpoint === 'workspace/follow' && nativeWorkspace) {
              if (item?.type === 'archived') nativeWorkspace = { ...nativeWorkspace, archivedSessionIds: item.archivedSessionIds }
              if (item?.type === 'pinned') nativeWorkspace = { ...nativeWorkspace, pinnedSessionIds: item.pinnedSessionIds }
              if (item?.type === 'order' && Array.isArray(item.workspaceIds) && Array.isArray(nativeWorkspace.items)) {
                const items = nativeWorkspace.items
                nativeWorkspace = { ...nativeWorkspace, items: item.workspaceIds.flatMap(id => items.filter(value => row(value)?.workspaceId === id)) }
              }
            }
            if (endpoint === 'workspace/follow' && item?.type === 'archived') {
              const entries = await backend.catalog(combined)
              queue.push({ ...item, archivedSessionIds: [...new Set([...(Array.isArray(item.archivedSessionIds) ? item.archivedSessionIds : []), ...entries.filter(entry => entry.archived).map(entry => entry.sessionId)])] })
            } else queue.push(frame)
          }
        }
      } finally { lifetime.abort(); unsubscribe(); queue.close() }
    })().catch(() => queue.close())
    if (endpoint === '$events' || endpoint === 'session/control') void (async () => {
      const extra = await backend.open(endpoint, { args: {} }, combined)
      for await (const frame of extra) {
        if (combined.aborted) break
        // Native carrier owns ready/baseline; never replace the native baseline.
        if (row(frame)?.type !== 'ready' && row(frame)?.type !== 'baseline') queue.push(frame)
      }
    })().catch(() => { lifetime.abort(); queue.close() })
    return queue.iterate(() => { lifetime.abort(); unsubscribe() })
  }
  if (stream) runtime.stream = async request => {
    const endpoint = `${request.namespace}/${request.method}`
    const signal = request.signal ?? new AbortController().signal
    if (await owns(endpoint, { args: request.args }, request.signal ?? new AbortController().signal, request.peer)) {
      if (!isLiveOwner(request.peer)) throw ownerDenied()
      return backend.open(endpoint, { args: request.args }, ownerSignal(signal, request.peer))
    }
    if (!isLiveOwner(request.peer)) return stream.call(runtime, request)
    return mapStream(endpoint, streamSignal => stream.call(runtime, { ...request, signal: streamSignal }), ownerSignal(signal, request.peer))
  }
  if (open) runtime.openWireStream = async (...args) => {
    const [endpoint, payload] = args as [string, unknown]
    const signal = (args.length >= 5 ? args[4] : args[2]) as AbortSignal
    const peer = args.length >= 5 ? args[3] : undefined
    if (await owns(endpoint, payload, signal, peer)) {
      if (!isLiveOwner(peer)) throw ownerDenied()
      return backend.open(endpoint, payload, ownerSignal(signal, peer))
    }
    if (!isLiveOwner(peer)) return open.apply(runtime, args)
    return mapStream(endpoint, streamSignal => { const forwarded = [...args]; forwarded[args.length >= 5 ? 4 : 2] = streamSignal; return open.apply(runtime, forwarded) }, ownerSignal(signal, peer))
  }
  if (open && runtime.openWireStream) Object.defineProperty(runtime.openWireStream, 'length', { value: open.length })
  return () => { runtime.invoke = invoke; runtime.dispatchRpc = dispatch; runtime.stream = stream; runtime.openWireStream = open }
}
