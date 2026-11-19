import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { ManagedSessionStore, type ManagedSession, type ManagedSessionScope, type JsonValue } from './managed-session-store/index.js'
import { ManagedAgentRuntime } from './managed-agents/runtime.js'
import type { ManagedAgentConnection, ManagedAgentEvent } from './managed-agents/types.js'
import type { TypertGatewayRequest, TypertRpcResult } from './typert-gateway-contract.js'
import { AsyncValueQueue, carrierArgs, requestArg } from './codex/virtual-contract.js'
import { adaptEventData } from './codex/virtual-history.js'

const id = z.string().min(1).max(512)
const createSchema = z.object({ workspaceId: id, agentId: id, operationId: id }).strict()
const promptSchema = z.object({ sessionId: id, requestId: id, content: z.array(z.object({ type: z.literal('text'), text: z.string().max(262144) }).strict()).min(1).max(16), mode: z.enum(['queue', 'steer']).optional() })
type Workspace = { workspaceId: string; path: string }
type Principal = { ownerId: string; hostId: string }
type NativeRecord = { type: 'event'; event: { type: string; seq: number; time: number; data: unknown; surfaceOp?: 'append' } }

/** One Host owns execution; callers only own subscriptions and scoped operations. */
export class ManagedAgentBackend {
  private readonly listeners = new Set<() => void>()
  private readonly sessions = new Map<string, ManagedSession>()
  private readonly opening = new Map<string, Promise<ManagedAgentConnection>>()
  private readonly busy = new Set<string>()
  private readonly optionFlights = new Set<string>()
  private readonly approvals = new Map<string, { session: ManagedSession; requestId: string; choices: string[]; title: string; data: unknown }>()
  private readonly eventQueues = new Map<AsyncValueQueue, Principal | undefined>()
  private readonly closedSignal = new AbortController()
  private readonly unsubscribe: () => void
  private readonly turns = new Map<string, number>()

  constructor(
    readonly store: ManagedSessionStore,
    readonly runtime: ManagedAgentRuntime,
    private readonly principal: () => Principal | undefined,
    private readonly workspaces: (signal?: AbortSignal) => Promise<readonly Workspace[]>,
  ) {
    this.unsubscribe = store.subscribe(() => { for (const callback of this.listeners) callback() })
  }

  ownsSession(sessionId: string): boolean { return this.sessions.has(sessionId) }
  subscribeCatalog(callback: () => void): () => void { this.listeners.add(callback); return () => { this.listeners.delete(callback) } }
  private scope(workspaceId: string): ManagedSessionScope {
    const principal = this.principal()
    if (!principal) throw new Error('MANAGED_AUTH_REQUIRED')
    return { ...principal, workspaceId }
  }
  private assertPrincipal(expected: Principal, signal?: AbortSignal): void {
    signal?.throwIfAborted()
    const current = this.principal()
    if (!current || current.ownerId !== expected.ownerId || current.hostId !== expected.hostId) throw new Error('MANAGED_AUTH_CHANGED')
  }
  private async visible(signal?: AbortSignal): Promise<ManagedSession[]> {
    const current = this.principal()
    if (!current) { this.sessions.clear(); return [] }
    const expected = { ...current }
    const workspaces = await this.workspaces(signal)
    this.assertPrincipal(expected, signal)
    const rows = workspaces.flatMap(workspace => this.store.listSessions({ ...expected, workspaceId: workspace.workspaceId })
      .filter(session => session.workspacePath === workspace.path))
    this.sessions.clear()
    for (const row of rows) this.sessions.set(row.id, row)
    return rows
  }
  async catalog(signal?: AbortSignal) {
    return (await this.visible(signal)).map(session => ({ sessionId: session.id, workspaceId: session.workspaceId, agentId: session.agentId, summary: this.summary(session) }))
  }
  private async requireSession(sessionId: string, signal?: AbortSignal): Promise<ManagedSession> {
    const session = (await this.visible(signal)).find(item => item.id === sessionId)
    if (!session) throw new Error('MANAGED_SESSION_NOT_FOUND')
    this.assertPrincipal(session, signal)
    return session
  }
  private records(session: ManagedSession): NativeRecord[] {
    const result: NativeRecord[] = []
    let cursor = 0
    for (;;) {
      const page = this.store.readEvents(session, session.id, cursor, 1000)
      for (const item of page.events) {
        const payload = item.payload as { type: string; data: unknown }
        result.push({ type: 'event', event: { type: payload.type, seq: item.sequence - 1, time: item.createdAt,
          data: adaptEventData(payload.type, payload.data, 'v3'),
          ...(['user/message', 'assistant/message', 'tool/result'].includes(payload.type) ? { surfaceOp: 'append' as const } : {}),
        } })
      }
      if (!page.hasMore) break
      cursor = page.nextSequence
    }
    return result
  }
  private summary(session: ManagedSession) {
    const records = this.records(session)
    const selected = this.selection(session)
    return { sessionId: session.id, updatedAt: session.updatedAt, cwd: session.workspacePath, agentAvailable: true, formatStatus: 'current',
      running: this.busy.has(session.id), blank: records.length === 0, agentId: session.agentId,
      projections: { kind: 'sequenced', asOfSeq: records.length - 1, values: {
        title: session.title, managedAgent: { agentId: session.agentId },
        modelSelection: { lastUsed: selected ?? null, next: selected ?? null },
        sessionListMetadata: { blank: records.length === 0, lastPromptAt: records.length ? session.updatedAt : null },
      } } }
  }
  private append(session: ManagedSession, type: string, data: unknown, eventId: string = randomUUID()): void {
    this.store.appendEvent(session, session.id, { eventId, type: 'native', payload: JSON.parse(JSON.stringify({ type, data })) as JsonValue })
  }
  private emit(session: ManagedSession, event: ManagedAgentEvent): void {
    const turn = this.turns.get(session.id) ?? 1
    if (event.type === 'text' || event.type === 'reasoning') {
      this.append(session, 'assistant/message', { turn, step: 1, message: { id: randomUUID(), role: 'assistant',
        content: [{ type: event.type === 'text' ? 'text' : 'reasoning', text: event.text }],
        source: { kind: 'model', provider: session.agentId, model: session.agentId } } })
    } else if (event.type === 'tool') {
      if (event.status === 'running') this.append(session, 'tool/call', { turn, step: 1, callId: event.itemId, name: event.name, arguments: JSON.stringify(event.data) })
      else this.append(session, 'tool/result', { turn, step: 1, message: { id: `${event.itemId}:result`, role: 'user',
        content: [{ type: 'tool-result', toolCallId: event.itemId, content: [{ type: 'text', text: JSON.stringify(event.data) }] }], source: { kind: 'tool', callId: event.itemId } } })
    } else if (event.type === 'approval') {
      const eventId = `managed-agent:${session.id}:${event.requestId}`
      this.approvals.set(eventId, { session, requestId: event.requestId, choices: event.choices, title: event.title, data: event.data })
      this.publishApproval(eventId, this.approvals.get(eventId)!)
    } else if (event.type === 'turn-completed') {
      for (const [key, approval] of this.approvals) if (approval.session.id === session.id) this.approvals.delete(key)
      this.busy.delete(session.id)
      this.append(session, 'step/end', { turn, step: 1 })
      this.append(session, 'turn/end', { turn, reason: event.status === 'completed' ? { kind: 'completed' }
        : event.status === 'cancelled' ? { kind: 'interrupted' } : { kind: 'error', error: { code: 'MANAGED_TURN_FAILED', message: 'Agent turn failed.' } } })
    } else if (event.type === 'error' || event.type === 'unavailable') {
      const wasBusy = this.busy.has(session.id)
      if (event.type === 'unavailable') {
        this.busy.delete(session.id)
        for (const [key, approval] of this.approvals) if (approval.session.id === session.id) this.approvals.delete(key)
      }
      this.append(session, 'assistant/message', { turn, step: 1, message: { id: randomUUID(), role: 'assistant',
        content: [{ type: 'text', text: `Agent error: ${event.code}` }], source: { kind: 'model', provider: session.agentId, model: session.agentId } } })
      if (event.type === 'unavailable' && wasBusy) {
        this.append(session, 'step/end', { turn, step: 1 })
        this.append(session, 'turn/end', { turn, reason: { kind: 'error', error: { code: event.code, message: 'Agent process became unavailable.' } } })
      }
    }
  }
  private publishApproval(eventId: string, approval: { session: ManagedSession; requestId: string; choices: string[]; title: string; data: unknown }, target?: AsyncValueQueue) {
    for (const [queue, owner] of this.eventQueues) {
      const current = this.principal()
      if (!owner || !current || owner.ownerId !== current.ownerId || owner.hostId !== current.hostId) { queue.close(); continue }
      if (owner.ownerId !== approval.session.ownerId || owner.hostId !== approval.session.hostId || (target && queue !== target)) continue
      queue.push({ type: 'waterfall', event: 'approval/request', eventId, agentId: approval.session.id,
        request: { toolName: approval.title, reason: JSON.stringify(approval.data).slice(0, 16384) } })
    }
  }
  private async connect(session: ManagedSession): Promise<ManagedAgentConnection> {
    session = this.store.getSession(session, session.id)
    const prior = this.opening.get(session.id)
    if (prior) return prior
    const operation = (async () => {
      if (!session.providerSessionId) {
        const admission = this.store.beginOperation(session, session.id, { operationId: 'provider-create', kind: 'create-provider', input: { agent: session.agentId } })
        if (!admission.execute) throw new Error('MANAGED_PROVIDER_CREATE_UNCERTAIN')
      }
      const selected = this.selection(session)
      const connection = await this.runtime.open({ sessionId: session.id, agent: session.agentId, workspacePath: session.workspacePath,
        ...(selected ? { model: selected.model, ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}) } : {}),
        ...(session.providerSessionId ? { providerSessionId: session.providerSessionId } : {}) }, event => this.emit(session, event))
      this.store.bindProviderSession(session, session.id, connection.providerSessionId)
      if (!session.providerSessionId) this.store.completeOperation(session, session.id, 'provider-create', 'completed', { providerSessionId: connection.providerSessionId })
      return connection
    })()
    this.opening.set(session.id, operation)
    try { return await operation } finally { this.opening.delete(session.id) }
  }
  async invoke(request: TypertGatewayRequest): Promise<unknown> {
    const response = await this.dispatch(`${request.namespace}/${request.method}`, { args: request.args }, request.signal ?? new AbortController().signal)
    if (!response.ok) throw Object.assign(new Error(response.error.message), response.error)
    return response.value
  }
  async dispatch(endpoint: string, payload: unknown, signal: AbortSignal): Promise<TypertRpcResult> {
    try { signal.throwIfAborted(); return { ok: true, value: await this.call(endpoint, requestArg(carrierArgs(payload)), signal) } }
    catch (error) { return { ok: false, error: { code: 'managed-agent/rejected', message: error instanceof z.ZodError ? 'Invalid managed Agent request.' : error instanceof Error ? error.message : 'Managed Agent request failed.', details: {} } } }
  }
  private async call(endpoint: string, request: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (endpoint === 'managedAgent/agents') return { items: this.runtime.registry.definitions().map(definition => ({ id: definition.agent, name: definition.title, available: true })) }
    if (endpoint === 'managedAgent/create') {
      const input = createSchema.parse(request)
      if (!this.runtime.registry.definition(input.agentId)) throw new Error('MANAGED_AGENT_UNAVAILABLE')
      const expected = this.scope(input.workspaceId)
      const workspace = (await this.workspaces(signal)).find(item => item.workspaceId === input.workspaceId)
      this.assertPrincipal(expected, signal)
      if (!workspace) throw new Error('MANAGED_WORKSPACE_NOT_FOUND')
      const session = this.store.createSession(expected, { ...input, providerId: input.agentId, workspacePath: workspace.path })
      this.sessions.set(session.id, session)
      for (const callback of this.listeners) callback()
      return { sessionId: session.id }
    }
    if (endpoint === '$events/result') {
      const approval = this.approvals.get(id.parse(request.eventId))
      if (!approval) throw new Error('MANAGED_APPROVAL_EXPIRED')
      await this.requireSession(approval.session.id, signal)
      const outcome = request.outcome as { kind?: string; value?: string } | undefined
      const choice = outcome?.kind === 'result' && outcome.value === 'allowed-once' ? 'allow-once'
        : outcome?.kind === 'cancel' || (outcome?.kind === 'result' && outcome.value === 'cancelled') ? 'cancel' : 'reject-once'
      const connection = await this.connect(approval.session)
      this.assertPrincipal(approval.session, signal)
      await connection.approve(approval.requestId, choice)
      this.approvals.delete(String(request.eventId))
      return undefined
    }
    const address = request.address as { sessionId?: string; id?: string } | undefined
    const session = await this.requireSession(id.parse(request.sessionId ?? address?.sessionId ?? address?.id), signal)
    if (endpoint === 'session/rename') { const title = z.string().min(1).max(1024).parse(request.title); this.store.renameSession(session, session.id, title); for (const callback of this.listeners) callback(); return { title } }
    if (endpoint === 'session/projections') return this.summary(session).projections
    if (endpoint === 'session/prompt') {
      const input = promptSchema.parse(request)
      const text = input.content.map(item => item.text).join('\n')
      if (!text.trim()) throw new Error('MANAGED_EMPTY_PROMPT')
      if (input.mode === 'steer') throw new Error('MANAGED_STEERING_NOT_SUPPORTED')
      const previous = this.store.getOperation(session, session.id, input.requestId)
      if (!previous && (this.busy.has(session.id) || this.optionFlights.has(session.id) || this.store.listOperations(session, session.id).some(operation =>
        operation.kind === 'send' && (operation.status === 'pending' || operation.status === 'unknown')))) throw new Error('MANAGED_SESSION_BUSY')
      const admission = this.store.beginOperation(session, session.id, { operationId: input.requestId, kind: 'send', input: { text } })
      if (!admission.execute) {
        if (admission.receipt.status === 'completed') return { accepted: true }
        if (admission.receipt.status === 'failed') throw new Error('MANAGED_SEND_REJECTED')
        throw new Error('MANAGED_SEND_OUTCOME_UNKNOWN')
      }
      this.busy.add(session.id)
      const turn = this.records(session).filter(item => item.event.type === 'turn/start').length + 1
      this.turns.set(session.id, turn)
      this.append(session, 'user/message', { id: input.requestId, role: 'user', content: input.content, source: { kind: 'user', rpcId: input.requestId } }, `user:${input.requestId}`)
      this.append(session, 'turn/start', { turn })
      this.append(session, 'step/start', { turn, step: 1 })
      let dispatched = false
      try {
        const connection = await this.connect(session)
        this.assertPrincipal(session, signal)
        dispatched = true
        const result = await connection.send({ messageId: input.requestId, text })
        if (result.state === 'rejected') {
          this.store.completeOperation(session, session.id, input.requestId, 'failed', { code: 'MANAGED_SEND_REJECTED' })
          if (this.busy.has(session.id)) this.emit(session, { type: 'turn-completed', status: 'failed' })
          throw new Error('MANAGED_SEND_REJECTED')
        }
        if (result.state !== 'accepted') throw new Error('MANAGED_SEND_OUTCOME_UNKNOWN')
        this.store.completeOperation(session, session.id, input.requestId, 'completed', JSON.parse(JSON.stringify(result)))
        return { accepted: true }
      } catch (error) {
        if (!dispatched) {
          this.store.completeOperation(session, session.id, input.requestId, 'failed', { code: 'MANAGED_START_FAILED' })
          if (this.busy.has(session.id)) this.emit(session, { type: 'turn-completed', status: 'failed' })
        }
        throw error
      }
    }
    if (endpoint === 'session/cancel') { await (await this.connect(session)).cancel(); return { accepted: true } }
    if (endpoint === 'session/models' || endpoint === 'session/modelCatalog') {
      const catalog = await this.models(session)
      return { ...catalog, current: this.selection(session), routable: catalog.groups.length > 0, routableProviders: [session.agentId] }
    }
    if (endpoint === 'session/initializeDefaultModel') return { selected: this.selection(session) }
    if (endpoint === 'session/selectModel') {
      if (this.busy.has(session.id)) throw new Error('MANAGED_SESSION_BUSY')
      if (this.optionFlights.has(session.id)) throw new Error('MANAGED_SESSION_BUSY')
      this.optionFlights.add(session.id)
      try {
      const model = id.parse(request.model)
      if (request.provider !== session.agentId) throw new Error('MANAGED_MODEL_UNAVAILABLE')
      const catalog = await this.models(session)
      const offered = catalog.groups.flatMap(group => group.models).find(candidate => candidate.id === model)
      if (!offered) throw new Error('MANAGED_MODEL_UNAVAILABLE')
      const reasoningEffort = request.reasoningEffort === undefined ? undefined : id.parse(request.reasoningEffort)
      if (reasoningEffort && !offered.reasoning?.efforts.some(effort => effort.id === reasoningEffort)) throw new Error('MANAGED_REASONING_UNAVAILABLE')
      const connection = await this.connect(session)
      if (!connection.setOption) throw new Error('MANAGED_OPTIONS_UNAVAILABLE')
      signal.throwIfAborted()
      const owner = this.principal()
      if (!owner || owner.ownerId !== session.ownerId || owner.hostId !== session.hostId) throw new Error('MANAGED_AUTH_CHANGED')
      if (this.busy.has(session.id)) throw new Error('MANAGED_SESSION_BUSY')
      await connection.setOption('model', model)
      if (reasoningEffort) await connection.setOption('reasoningEffort', reasoningEffort)
      const selected = { provider: session.agentId, model, ...(reasoningEffort ? { reasoningEffort } : {}) }
      this.append(session, 'model/selection', selected)
      return { selected }
      } finally { this.optionFlights.delete(session.id) }
    }
    if (endpoint === 'session/history' || endpoint === 'session/page' || endpoint === 'session/events') {
      const records = this.records(session)
      const through = request.throughSeq === undefined ? records.length - 1 : z.number().int().min(-1).parse(request.throughSeq)
      const before = request.beforeSeq === undefined ? records.length : z.number().int().nonnegative().parse(request.beforeSeq)
      const limit = request.maxMessages === undefined ? 50 : z.number().int().positive().max(1000).parse(request.maxMessages)
      const slice = records.filter(record => record.event.seq <= through && record.event.seq < before).slice(-limit)
      return { header: this.header(session), records: slice, cursor: Math.min(through, records.length - 1), hasMore: (slice[0]?.event.seq ?? 0) > 0 }
    }
    throw new Error('MANAGED_METHOD_NOT_SUPPORTED')
  }
  private selection(session: ManagedSession): { provider: string; model: string; reasoningEffort?: string } | undefined {
    return this.records(session).reverse().find(record => record.event.type === 'model/selection')?.event.data as { provider: string; model: string; reasoningEffort?: string } | undefined
  }
  private async models(session: ManagedSession) {
    const connection = await this.connect(session)
    const raw = await connection.models?.()
    const principal = this.principal()
    if (!principal || principal.ownerId !== session.ownerId || principal.hostId !== session.hostId) throw new Error('MANAGED_AUTH_CHANGED')
    const actualDefault = connection.defaultModel
    if (!this.selection(session) && actualDefault) this.append(session, 'model/selection', { provider: session.agentId, ...actualDefault })
    const response = raw as { data?: unknown[] } | undefined
    const values = Array.isArray(raw) ? raw : Array.isArray(response?.data) ? response.data : []
    const models: Array<{ id: string; name: string; reasoning?: { efforts: Array<{ id: string; name: string }> } }> = []
    for (const value of values) {
      if (typeof value !== 'object' || value === null) continue
      const row = value as Record<string, unknown>
      const name = row.model ?? row.value ?? row.id
      if (typeof name !== 'string' || row.hidden === true || models.some(model => model.id === name)) continue
      const efforts = Array.isArray(row.supportedReasoningEfforts) ? row.supportedReasoningEfforts.flatMap(item => {
        const effort = item as { reasoningEffort?: string; description?: string }
        return typeof effort.reasoningEffort === 'string' ? [{ id: effort.reasoningEffort, name: effort.reasoningEffort }] : []
      }) : []
      models.push({ id: name, name: typeof row.displayName === 'string' ? row.displayName : name,
        ...(efforts.length ? { reasoning: { efforts } } : {}) })
    }
    return { groups: models.length ? [{ id: session.agentId, name: session.agentId, models }] : [], failures: [] }
  }
  async managedModelCatalog(signal: AbortSignal) {
    const sessions = await this.visible(signal)
    const groups: Awaited<ReturnType<ManagedAgentBackend['models']>>['groups'] = []
    const failures: Array<{ id: string; name: string; message: string }> = []
    let defaultSelection: ReturnType<ManagedAgentBackend['selection']>
    for (const session of sessions) {
      try {
        const catalog = await this.models(session)
        this.assertPrincipal(session, signal)
        for (const group of catalog.groups) {
          const existing = groups.find(item => item.id === group.id)
          if (existing) existing.models.push(...group.models.filter(model => !existing.models.some(item => item.id === model.id)))
          else groups.push(group)
        }
        defaultSelection ??= this.selection(session)
      } catch (error) {
        this.assertPrincipal(session, signal)
        failures.push({ id: session.agentId, name: session.agentId, message: 'Unable to read the local Agent model configuration.' })
      }
    }
    return { groups, failures, routableProviders: groups.map(group => group.id), ...(defaultSelection ? { default: defaultSelection } : {}) }
  }
  private header(session: ManagedSession) { return { version: 3, id: session.id, createdAt: session.createdAt, cwd: session.workspacePath, isSeeded: false } }
  async open(endpoint: string, payload: unknown, inputSignal: AbortSignal): Promise<AsyncIterable<unknown>> {
    const signal = AbortSignal.any([inputSignal, this.closedSignal.signal])
    signal.throwIfAborted()
    const queue = new AsyncValueQueue(signal)
    if (endpoint === 'session/control') {
      const pinned = this.principal()
      const expected = pinned ? { ...pinned } : undefined
      queue.push({ type: 'baseline', value: { queues: {}, jobs: {}, projections: {} } })
      const unsubscribe = this.store.subscribe(session => {
        const owner = this.principal()
        if (!expected || !owner || owner.ownerId !== expected.ownerId || owner.hostId !== expected.hostId) { queue.close(); return }
        if (owner.ownerId !== session.ownerId || owner.hostId !== session.hostId) return
        const projection = this.summary(session).projections
        queue.push({ type: 'projection', sessionId: session.id, seq: projection.asOfSeq, changes: projection.values })
      })
      return queue.iterate(unsubscribe)
    }
    if (endpoint === '$events') {
      this.eventQueues.set(queue, this.principal())
      queue.push({ type: 'ready', clientId: `managed:${randomUUID()}`, host: {} })
      for (const [key, value] of this.approvals) this.publishApproval(key, value, queue)
      return queue.iterate(() => { this.eventQueues.delete(queue) })
    }
    const request = requestArg(carrierArgs(payload))
    const address = request.address as { sessionId?: string; id?: string } | undefined
    const session = await this.requireSession(id.parse(request.sessionId ?? address?.sessionId ?? address?.id), signal)
    if (endpoint !== 'session/follow') throw new Error('MANAGED_STREAM_NOT_SUPPORTED')
    this.assertPrincipal(session, signal)
    const records = this.records(session)
    queue.push({ type: 'snapshot', header: this.header(session), cursor: records.length - 1, records: records.slice(-100),
      hasMore: records.length > 100, projections: this.summary(session).projections, assistantStream: { revision: 0 } })
    const unsubscribe = this.store.subscribe((owner, event) => {
      if (owner.id !== session.id) return
      const principal = this.principal()
      if (!principal || principal.hostId !== owner.hostId || principal.ownerId !== owner.ownerId) { queue.close(); return }
      const data = event.payload as { type: string; data: unknown }
      queue.push({ type: 'event', event: { type: data.type, seq: event.sequence - 1, time: event.createdAt,
        data: adaptEventData(data.type, data.data, 'v3'), ...(['user/message', 'assistant/message', 'tool/result'].includes(data.type) ? { surfaceOp: 'append' } : {}) } })
    })
    return queue.iterate(unsubscribe)
  }
  async close(): Promise<void> {
    this.closedSignal.abort(); this.unsubscribe(); this.listeners.clear()
    await this.runtime.closeAll()
    this.store.close()
  }
}
