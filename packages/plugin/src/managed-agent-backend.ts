import { ManagedLaunchRegistry } from './managed-agents/launch.js'
import type { AttachmentStore, AdmittedPromptContentPart } from '@deepseek-ai/dsh-attachment'
import { ManagedAssistantStream } from './managed-agents/stream.js'
import type { ManagedTitleInput } from './managed-agents/title.js'
import { managementRequest, managementPayload, managementReads, managementWhileBusy } from './managed-agents/management-validation.js'
import type { ManagedManagementOperation } from './managed-agents/management.js'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { ManagedSessionStore, type ManagedSession, type ManagedSessionScope, type JsonValue } from './managed-session-store/index.js'
import { ManagedAgentRuntime } from './managed-agents/runtime.js'
import type { ManagedAgentConnection, ManagedAgentEvent } from './managed-agents/types.js'
import type { TypertGatewayRequest, TypertRpcResult } from './typert-gateway-contract.js'
import { AsyncValueQueue, carrierArgs, requestArg } from './codex/virtual-contract.js'
import { adaptEventData } from './codex/virtual-history.js'

const id = z.string().min(1).max(512)
const createSchema = z.object({ workspaceId: id, agentId: id, operationId: id }).strict()
const promptSchema = z.object({ sessionId: id, requestId: id, content: z.array(z.union([z.object({ type: z.literal('text'), text: z.string().max(262144) }).strict(), z.object({ type: z.literal('image'), mediaType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']), data: z.string().max(5600000), name: z.string().max(255).optional() }).strict()])).min(1).max(16), mode: z.enum(['queue', 'steer']).optional() })
type Workspace = { workspaceId: string; path: string }
type Principal = { ownerId: string; hostId: string }
type NativeRecord = { type: 'event'; event: { type: string; seq: number; time: number; data: unknown; surfaceOp?: 'append' } }

/** One Host owns execution; callers only own subscriptions and scoped operations. */
export class ManagedAgentBackend {
  private readonly listeners = new Set<() => void>()
  private readonly sessions = new Map<string, ManagedSession>()
  private readonly opening = new Map<string, Promise<ManagedAgentConnection>>()
  private readonly busy = new Set<string>()
  private readonly queuePumps = new Set<string>()
  private readonly steering = new Set<string>()
  private readonly managementFlights = new Set<string>()
  private readonly liveOperations = new Map<string, readonly ManagedManagementOperation[]>()
  private readonly questions = new Map<string, Map<string, { requestId: string; title: string; questions: unknown }>>()
  private readonly optionFlights = new Set<string>()
  private readonly approvals = new Map<string, { session: ManagedSession; requestId: string; choices: string[]; title: string; data: unknown }>()
  private readonly eventQueues = new Map<AsyncValueQueue, Principal | undefined>()
  private readonly closedSignal = new AbortController()
  private readonly unsubscribe: () => void
  private readonly streams = new Map<string, ManagedAssistantStream>()
  private readonly streamListeners = new Map<string, Set<(frame: unknown) => void>>()
  private readonly promptStarts = new Map<string, number>()
  private readonly turns = new Map<string, number>()

  private readonly titleJobs = new Set<Promise<void>>()

  constructor(
    readonly store: ManagedSessionStore,
    readonly runtime: ManagedAgentRuntime,
    private readonly principal: () => Principal | undefined,
    private readonly workspaces: (signal?: AbortSignal) => Promise<readonly Workspace[]>,
    private readonly services: { launches?: ManagedLaunchRegistry; attachments?: Pick<AttachmentStore, 'admitPromptContent' | 'readImage'>; nativeArchived?: (signal: AbortSignal) => Promise<string[]>; generateTitle?: (input: ManagedTitleInput) => Promise<string> } = {},
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
    return (await this.visible(signal)).map(session => ({ sessionId: session.id, workspaceId: session.workspaceId, agentId: session.agentId, archived: session.archived === true, summary: this.summary(session) }))
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
    const prompts = records.filter(record => record.event.type === 'user/message')
    const blank = prompts.length === 0
    // Configuration and title events are not conversation content. The native
    // sidebar hides a blank session when it is no longer the selected session.
    const title = session.title === 'New conversation' && !records.some(record => record.event.type === 'session/title')
      ? this.promptTitle(prompts[0]?.event.data) ?? session.title : session.title
    return { sessionId: session.id, updatedAt: session.updatedAt, cwd: session.workspacePath, agentAvailable: true, formatStatus: 'current',
      running: this.busy.has(session.id), blank, agentId: session.agentId,
      projections: { kind: 'sequenced', asOfSeq: records.length - 1, values: {
        title, managedAgent: this.agentIdentity(session.agentId, session.id),
        modelSelection: { lastUsed: selected ?? null, next: selected ?? null },
        sessionListMetadata: { blank, lastPromptAt: prompts.at(-1)?.event.time ?? null },
      } } }
  }
  /** Transport capabilities describe implemented endpoints, not Orca adapter aspirations.
   * Registration alone does not prove a CLI is installed or its credentials work. */
  private agentIdentity(agentId: string, sessionId?: string) {
    const operations = sessionId ? this.liveOperations.get(sessionId) ?? [] : []
    const definition = this.runtime.registry.definition(agentId)
    return { agentId, name: definition?.title ?? agentId, icon: definition?.icon ?? agentId,
      registered: definition !== null, availability: 'unverified' as const,
      capabilities: {
        textPrompts: true, imagePrompts: Boolean(this.services.attachments), fileAttachments: false,
        steering: sessionId ? this.steering.has(sessionId) : false, queueWhileBusy: true, modelSelection: true,
        reasoningEffort: agentId === 'codex', rename: true, archive: true, unarchive: true,
        pin: false, move: false, fork: operations.includes('fork'), rewind: operations.includes('rewind'), compact: operations.includes('compact'),
        threadGoal: operations.includes('goal.set'), contextUsage: operations.includes('context'),
      },
    }
  }
  private promptTitle(data: unknown): string | undefined {
    const content = (data as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content
    const text = content?.filter(block => block.type === 'text').map(block => block.text ?? '').join(' ').replace(/\s+/gu, ' ').trim()
    if (!text) return undefined
    const characters = Array.from(text)
    return characters.length > 72 ? characters.slice(0, 71).join('') + '…' : text
  }
  private rename(session: ManagedSession, title: string, source: 'user' | 'fallback' | 'provider', messageSeqs: number[] = []): number {
    this.store.renameSession(session, session.id, title)
    this.append(session, 'session/title', { title, source: source === 'provider' ? { kind: source, provider: session.agentId } : { kind: source }, messageSeqs })
    return this.records(session).at(-1)!.event.seq
  }
  private generateTitle(session: ManagedSession, model?: string): void {
    const generate = this.services.generateTitle
    if (!generate || this.closedSignal.signal.aborted) return
    const records = this.records(session)
    const prompts = records.filter(record => record.event.type === 'user/message')
    const previous = records.filter(record => record.event.type === 'session/title').at(-1)
    if (prompts.length !== 1 || (previous?.event.data as { source?: { kind?: string } })?.source?.kind !== 'fallback') return
    const operationId = 'automatic-title-v1'
    if (this.store.getOperation(session, session.id, operationId)) return
    this.store.beginOperation(session, session.id, { operationId, kind: 'title', input: { messageSeq: prompts[0]!.event.seq } })
    const content = (prompts[0]!.event.data as { content: Array<{ text?: string }> }).content.map(block => block.text ?? '').join('\n').slice(0, 8000)
    const job = (async () => {
      try {
        const title = await generate({ agent: session.agentId, cwd: session.workspacePath, text: content, model, signal: this.closedSignal.signal })
        this.assertPrincipal(session, this.closedSignal.signal)
        const latest = this.records(session).filter(record => record.event.type === 'session/title').at(-1)
        // Manual renames (even renaming back to the fallback) always win.
        if (latest?.event.seq === previous?.event.seq && title.trim()) this.rename(session, Array.from(title.trim()).slice(0, 72).join(''), 'provider', [prompts[0]!.event.seq])
        this.store.completeOperation(session, session.id, operationId, 'completed', { generated: true })
      } catch {
        this.store.completeOperation(session, session.id, operationId, 'failed', { code: 'MANAGED_TITLE_UNAVAILABLE' })
      }
    })()
    this.titleJobs.add(job)
    void job.finally(() => this.titleJobs.delete(job)).catch(() => undefined)
  }
  private append(session: ManagedSession, type: string, data: unknown, eventId: string = randomUUID()): void {
    this.store.appendEvent(session, session.id, { eventId, type: 'native', payload: JSON.parse(JSON.stringify({ type, data })) as JsonValue })
  }
  private emit(session: ManagedSession, event: ManagedAgentEvent): void {
    const turn = this.turns.get(session.id) ?? 1
    if (event.type === 'text' || event.type === 'reasoning' || event.type === 'text-delta' || event.type === 'reasoning-delta') {
      if (!event.itemId && (event.type === 'text' || event.type === 'reasoning')) {
        this.append(session, 'assistant/message', { turn, step: 1, message: { id: randomUUID(), role: 'assistant', content: [{ type: event.type, text: event.text }], source: { kind: 'model', provider: session.agentId, model: session.agentId } } })
      } else {
        this.stream(session).accept(event.itemId!, event.type.startsWith('text') ? 'text' : 'reasoning', event.text, !event.type.endsWith('-delta'), this.records(session).length - 1, turn)
      }
    } else if (event.type === 'turn-started' || event.type === 'checkpoint') {
      if (event.type === 'checkpoint' && event.position === 'after') this.flushStream(session)
      if (event.type === 'turn-started') {
        if (!this.busy.has(session.id)) {
          this.busy.add(session.id)
          const nextTurn = this.records(session).filter(record => record.event.type === 'turn/start').length + 1
          this.turns.set(session.id, nextTurn)
          this.append(session, 'turn/start', { turn: nextTurn })
          this.append(session, 'step/start', { turn: nextTurn, step: 1 })
        }
        const start = this.promptStarts.get(session.id)
        if (start !== undefined) this.checkpoint(session, event.turnId, start - 1)
      } else this.checkpoint(session, event.checkpointId, event.position === 'after' ? this.records(session).length - 1 : (this.promptStarts.get(session.id) ?? 0) - 1)
    } else if (event.type === 'question') {
      let pending = this.questions.get(session.id)
      if (!pending) { pending = new Map(); this.questions.set(session.id, pending) }
      pending.set(event.requestId, { requestId: event.requestId, title: event.title, questions: event.questions })
      this.append(session, 'managed/question', event)
    } else if (['context-usage', 'account-usage', 'background-task', 'thread-goal', 'compacted', 'options'].includes(event.type)) {
      this.append(session, `managed/${event.type}`, 'data' in event ? event.data : {})
    } else if (event.type === 'tool') {
      this.flushStream(session)
      if (event.status === 'running') this.append(session, 'tool/call', { turn, step: 1, callId: event.itemId, name: event.name, arguments: JSON.stringify(event.data) })
      else this.append(session, 'tool/result', { turn, step: 1, message: { id: `${event.itemId}:result`, role: 'user',
        content: [{ type: 'tool-result', toolCallId: event.itemId, content: [{ type: 'text', text: JSON.stringify(event.data) }] }], source: { kind: 'tool', callId: event.itemId } } })
    } else if (event.type === 'approval') {
      const eventId = `managed-agent:${session.id}:${event.requestId}`
      this.approvals.set(eventId, { session, requestId: event.requestId, choices: event.choices, title: event.title, data: event.data })
      this.publishApproval(eventId, this.approvals.get(eventId)!)
    } else if (event.type === 'turn-completed') {
      this.flushStream(session)
      for (const [key, approval] of this.approvals) if (approval.session.id === session.id) this.approvals.delete(key)
      this.busy.delete(session.id)
      this.questions.delete(session.id)
      this.promptStarts.delete(session.id)
      this.append(session, 'step/end', { turn, step: 1 })
      this.append(session, 'turn/end', { turn, reason: event.status === 'completed' ? { kind: 'completed' }
        : event.status === 'cancelled' ? { kind: 'interrupted' } : { kind: 'error', error: { code: 'MANAGED_TURN_FAILED', message: 'Agent turn failed.' } } })
      queueMicrotask(() => { void this.drainQueue(session).catch(() => undefined) })
    } else if (event.type === 'error' || event.type === 'unavailable') {
      this.flushStream(session)
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
  private checkpoint(session: ManagedSession, checkpointId: string, throughSeq: number): void {
    if (this.records(session).some(record => record.event.type === 'managed/checkpoint' && (record.event.data as { checkpointId?: string }).checkpointId === checkpointId)) return
    this.append(session, 'managed/checkpoint', { checkpointId, throughSeq }, `checkpoint:${checkpointId}`)
  }
  private stream(session: ManagedSession): ManagedAssistantStream {
    let stream = this.streams.get(session.id)
    if (!stream) {
      stream = new ManagedAssistantStream(frame => { for (const listener of this.streamListeners.get(session.id) ?? []) listener(frame) })
      this.streams.set(session.id, stream)
    }
    return stream
  }
  private flushStream(session: ManagedSession): void {
    this.streams.get(session.id)?.flush(content => {
      this.append(session, 'assistant/message', { turn: this.turns.get(session.id) ?? 1, step: 1, message: {
        id: randomUUID(), role: 'assistant', content, source: { kind: 'model', provider: session.agentId, model: this.selection(session)?.model ?? session.agentId },
      } })
      return this.records(session).length - 1
    })
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
      let launch = this.launchSelection(session)
      const plan = this.services.launches?.resolve({ sessionId: session.id, agent: session.agentId, workspacePath: session.workspacePath, selection: launch, previous: launch, resuming: Boolean(session.providerSessionId), previousFingerprint: launch.ownerFingerprint })
      if (plan && !launch.ownerFingerprint) { launch = { ...launch, ownerFingerprint: plan.ownerFingerprint }; this.append(session, 'managed/launch', launch, 'launch-binding') }
      else if (!this.records(session).some(record => record.event.type === 'managed/launch')) this.append(session, 'managed/launch', launch, 'initial-launch')
      const restoredChildren = new Map<string, { id: string; parentThreadId: string; title: string; status: string; turnId?: string }>()
      for (const record of this.records(session)) if (record.event.type === 'managed/background-task') {
        const task = record.event.data as Record<string, unknown>
        if (typeof task.id === 'string' && typeof task.parentThreadId === 'string') restoredChildren.set(task.id, { id: task.id, parentThreadId: task.parentThreadId, title: typeof task.title === 'string' ? task.title : task.id, status: 'unknown', ...(typeof task.turnId === 'string' ? { turnId: task.turnId } : {}) })
      }
      const permission = this.records(session).filter(record => record.event.type === 'managed/permission').at(-1)?.event.data as { permissionMode?: string } | undefined
      const connection = await this.runtime.open({ ...(permission?.permissionMode ? { permissionMode: permission.permissionMode } : {}), sessionId: session.id, agent: session.agentId, workspacePath: session.workspacePath, launch, previousLaunch: launch, ...(launch.ownerFingerprint ? { launchFingerprint: launch.ownerFingerprint } : {}), restoredChildren: [...restoredChildren.values()],
        ...(selected ? { model: selected.model, ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}) } : {}),
        ...(session.providerSessionId ? { providerSessionId: session.providerSessionId } : {}) }, event => this.emit(session, event))
      if (connection.steer) this.steering.add(session.id)
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
    catch (error) { return { ok: false, error: { code: error instanceof Error && error.message === 'workspace/session-active' ? 'workspace/session-active' : 'managed-agent/rejected', message: error instanceof z.ZodError ? 'Invalid managed Agent request.' : error instanceof Error ? error.message : 'Managed Agent request failed.', details: error instanceof Error && error.message === 'workspace/session-active' ? (error as Error & { details: Record<string, unknown> }).details : {} } } }
  }
  private async call(endpoint: string, request: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (endpoint === 'managedAgent/agents') return { items: this.runtime.registry.definitions().map(definition => ({ id: definition.agent, ...this.agentIdentity(definition.agent), available: true })) }
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
    if (endpoint === 'managedAgent/management' || endpoint === 'managedAgent/manage') return this.management(session, endpoint, request, signal)
    if (endpoint === 'workspace/archiveSession' || endpoint === 'workspace/unarchiveSession') {
      const archived = endpoint === 'workspace/archiveSession'
      const native = await this.services.nativeArchived?.(signal) ?? []
      this.assertPrincipal(session, signal)
      if (archived && this.busy.has(session.id)) {
        if (request.stopActivity !== true) throw Object.assign(new Error('workspace/session-active'), { details: { sessionId: session.id, activity: [{ kind: 'turn' }] } })
        const connection = await this.connect(session)
        this.assertPrincipal(session, signal)
        await connection.cancel()
        this.assertPrincipal(session, signal)
      }
      this.store.setArchived(session, session.id, archived)
      for (const callback of this.listeners) callback()
      return { archivedSessionIds: [...new Set([...native, ...(await this.visible(signal)).filter(item => item.archived).map(item => item.id)])] }
    }
    if (endpoint === 'session/rename') {
      const title = z.string().trim().min(1).max(1024).parse(request.title)
      return { title, seq: this.rename(session, title, 'user') }
    }
    if (endpoint === 'session/projections') return this.summary(session).projections
    if (endpoint === 'session/prompt') {
      if (request.fileReceiptIds !== undefined && (!Array.isArray(request.fileReceiptIds) || request.fileReceiptIds.length > 0)) throw new Error('MANAGED_ATTACHMENTS_NOT_SUPPORTED')
      const input = promptSchema.parse(request)
      const text = input.content.filter(item => item.type === 'text').map(item => item.text).join('\n')
      const images = input.content.filter(item => item.type === 'image')
      if (images.length && !this.services.attachments) throw new Error('MANAGED_ATTACHMENTS_NOT_SUPPORTED')
      if (images.length > 8 || images.reduce((total, image) => total + image.data.length, 0) > 16000000) throw new Error('MANAGED_IMAGES_TOO_LARGE')
      if (!text.trim() && !images.length) throw new Error('MANAGED_EMPTY_PROMPT')
      if (input.mode === 'steer') return this.steerPrompt(session, input, signal)
      if (input.mode === 'queue' && this.busy.has(session.id)) return this.enqueuePrompt(session, input, signal)
      const previous = this.store.getOperation(session, session.id, input.requestId)
      if (!previous && (this.busy.has(session.id) || this.optionFlights.has(session.id) || this.managementFlights.has(session.id) || this.store.listOperations(session, session.id).some(operation =>
        (operation.kind === 'send' || operation.kind === 'steer' || (operation.kind.startsWith('manage:') && !['manage:queue.run', 'manage:queue.remove'].includes(operation.kind))) && (operation.status === 'pending' || operation.status === 'unknown')))) throw new Error('MANAGED_SESSION_BUSY')
      const admission = this.store.beginOperation(session, session.id, { operationId: input.requestId, kind: 'send', input: { text, ...(images.length ? { images: images.map(image => ({ mediaType: image.mediaType, hash: createHash('sha256').update(image.data).digest('hex') })) } : {}) } })
      if (!admission.execute) {
        if (admission.receipt.status === 'completed') return { accepted: true }
        if (admission.receipt.status === 'failed') throw new Error('MANAGED_SEND_REJECTED')
        throw new Error('MANAGED_SEND_OUTCOME_UNKNOWN')
      }
      let content: AdmittedPromptContentPart[] = []
      try {
        content = images.length ? await this.services.attachments!.admitPromptContent(input.content) : input.content as AdmittedPromptContentPart[]
        this.assertPrincipal(session, signal)
      } catch (error) {
        this.store.completeOperation(session, session.id, input.requestId, 'failed', { code: 'MANAGED_IMAGE_ADMISSION_FAILED' })
        throw error
      }
      this.busy.add(session.id)
      const turn = this.records(session).filter(item => item.event.type === 'turn/start').length + 1
      this.turns.set(session.id, turn)
      this.append(session, 'user/message', { id: input.requestId, role: 'user', content, source: { kind: 'user', rpcId: input.requestId } }, `user:${input.requestId}`)
      const promptSeq = this.records(session).length - 1
      this.promptStarts.set(session.id, promptSeq)
      const records = this.records(session)
      if (session.title === 'New conversation' && !records.some(record => record.event.type === 'session/title')) {
        const first = records.find(record => record.event.type === 'user/message')
        const title = this.promptTitle(first?.event.data)
        if (title && first) this.rename(session, title, 'fallback', [first.event.seq])
      }
      this.append(session, 'turn/start', { turn })
      this.append(session, 'step/start', { turn, step: 1 })
      let dispatched = false
      try {
        const connection = await this.connect(session)
        this.assertPrincipal(session, signal)
        dispatched = true
        const result = await connection.send({ messageId: input.requestId, text, ...(images.length ? { images: images.map(image => ({ mimeType: image.mediaType, data: image.data })) } : {}) })
        if (result.state === 'rejected') {
          this.store.completeOperation(session, session.id, input.requestId, 'failed', { code: 'MANAGED_SEND_REJECTED' })
          if (this.busy.has(session.id)) this.emit(session, { type: 'turn-completed', status: 'failed' })
          throw new Error('MANAGED_SEND_REJECTED')
        }
        if (result.state !== 'accepted') throw new Error('MANAGED_SEND_OUTCOME_UNKNOWN')
        if (result.providerTurnId && session.agentId === 'codex') this.checkpoint(session, result.providerTurnId, promptSeq - 1)
        this.store.completeOperation(session, session.id, input.requestId, 'completed', JSON.parse(JSON.stringify(result)))
        this.generateTitle(session, this.selection(session)?.model ?? connection.defaultModel?.model)
        if (!this.busy.has(session.id)) queueMicrotask(() => { void this.drainQueue(session).catch(() => undefined) })
        return { accepted: true }
      } catch (error) {
        if (!dispatched) {
          this.store.completeOperation(session, session.id, input.requestId, 'failed', { code: 'MANAGED_START_FAILED' })
          if (this.busy.has(session.id)) this.emit(session, { type: 'turn-completed', status: 'failed' })
        }
        throw error
      }
    }
    if (endpoint === 'session/attachment') {
      const attachment = request.attachment as { attachmentId?: string } | undefined
      const attachmentId = attachment?.attachmentId ?? request.attachmentId
      const found = this.records(session).flatMap(record => {
        const data = record.event.data as { content?: unknown[]; message?: { content?: unknown[] } }
        return data.content ?? data.message?.content ?? []
      }).find(block => (block as { type?: string; attachment?: { attachmentId?: string } }).type === 'image' && (block as { attachment?: { attachmentId?: string } }).attachment?.attachmentId === attachmentId) as { attachment: Parameters<AttachmentStore['readImage']>[0] } | undefined
      if (!found || !this.services.attachments) throw new Error('MANAGED_ATTACHMENT_NOT_FOUND')
      const image = await this.services.attachments.readImage(found.attachment, signal)
      this.assertPrincipal(session, signal)
      return { attachment: image.ref, data: image.data }
    }
    if (endpoint === 'session/cancel') { const connection = await this.connect(session); this.assertPrincipal(session, signal); await connection.cancel(); return { accepted: true } }
    if (endpoint === 'session/models' || endpoint === 'session/modelCatalog') {
      const catalog = await this.models(session)
      return { ...catalog, current: this.selection(session), routable: catalog.groups.length > 0, routableProviders: [session.agentId] }
    }
    if (endpoint === 'session/initializeDefaultModel') return { selected: this.selection(session) }
    if (endpoint === 'session/selectModel') {
      if (this.busy.has(session.id)) throw new Error('MANAGED_SESSION_BUSY')
      if (this.optionFlights.has(session.id) || this.managementFlights.has(session.id)) throw new Error('MANAGED_SESSION_BUSY')
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
  private queued(session: ManagedSession): Array<{ requestId: string; content: AdmittedPromptContentPart[]; state: string }> {
    const items = new Map<string, { requestId: string; content: AdmittedPromptContentPart[]; state: string }>()
    for (const record of this.records(session)) {
      if (record.event.type === 'managed/queued') { const value = record.event.data as { requestId: string; content: AdmittedPromptContentPart[] }; items.set(value.requestId, { ...value, state: 'queued' }) }
      if (record.event.type === 'managed/queue-status') { const value = record.event.data as { requestId: string; state: string }; const item = items.get(value.requestId); if (item) item.state = value.state }
    }
    return [...items.values()].filter(item => !['sent', 'removed'].includes(item.state))
  }
  private async enqueuePrompt(session: ManagedSession, input: z.infer<typeof promptSchema>, signal: AbortSignal) {
    if (this.queued(session).filter(item => item.state !== 'rejected').length >= 20) throw new Error('MANAGED_QUEUE_FULL')
    const operationId = `queue:${createHash('sha256').update(input.requestId).digest('hex')}`
    const fingerprint = input.content.map(part => part.type === 'text' ? part : { type: part.type, mediaType: part.mediaType, hash: createHash('sha256').update(part.data).digest('hex') })
    const admission = this.store.beginOperation(session, session.id, { operationId, kind: 'queue', input: fingerprint })
    if (!admission.execute) {
      if (admission.receipt.status === 'completed') return { accepted: true, queued: true }
      throw new Error('MANAGED_OPERATION_OUTCOME_UNKNOWN')
    }
    try {
      const content = input.content.some(part => part.type === 'image') ? await this.services.attachments!.admitPromptContent(input.content) : input.content as AdmittedPromptContentPart[]
      this.assertPrincipal(session, signal)
      this.append(session, 'managed/queued', { requestId: input.requestId, content }, `queued:${input.requestId}`)
      this.store.completeOperation(session, session.id, operationId, 'completed', { queued: true })
      if (!this.busy.has(session.id)) queueMicrotask(() => { void this.drainQueue(session).catch(() => undefined) })
      return { accepted: true, queued: true }
    } catch (error) {
      this.store.completeOperation(session, session.id, operationId, 'failed', { code: 'MANAGED_QUEUE_REJECTED' }); throw error
    }
  }
  private async drainQueue(session: ManagedSession): Promise<void> {
    if (this.queuePumps.has(session.id) || this.busy.has(session.id) || this.closedSignal.signal.aborted) return
    if (this.managementFlights.has(session.id) || this.optionFlights.has(session.id) || this.store.listOperations(session, session.id).some(receipt => (receipt.kind === 'send' || receipt.kind === 'steer') && receipt.status === 'pending')) return
    const items = this.queued(session)
    if (items.some(item => ['dispatching', 'unknown'].includes(item.state))) throw new Error('MANAGED_QUEUE_OUTCOME_UNKNOWN')
    const item = items.find(item => item.state === 'queued')
    if (!item) return
    this.queuePumps.add(session.id)
    try {
      await this.requireSession(session.id, this.closedSignal.signal)
      // Re-read verified durable attachments; never persist raw image bytes in the journal.
      const content = await Promise.all(item.content.map(async part => {
        if (part.type === 'text') return part
        if (part.type !== 'image' || !this.services.attachments) throw new Error('MANAGED_ATTACHMENT_NOT_FOUND')
        const image = await this.services.attachments.readImage(part.attachment, this.closedSignal.signal)
        return { type: 'image', mediaType: image.ref.mediaType, data: Buffer.from(image.data).toString('base64') }
      }))
      if (this.busy.has(session.id) || this.managementFlights.has(session.id) || this.queued(session).find(current => current.requestId === item.requestId)?.state !== 'queued') return
      this.append(session, 'managed/queue-status', { requestId: item.requestId, state: 'dispatching' })
      await this.call('session/prompt', { sessionId: session.id, requestId: item.requestId, content }, this.closedSignal.signal)
      this.append(session, 'managed/queue-status', { requestId: item.requestId, state: 'sent' })
    } catch (error) {
      const receipt = this.store.getOperation(session, session.id, item.requestId)
      this.append(session, 'managed/queue-status', { requestId: item.requestId, state: receipt?.status === 'failed' ? 'rejected' : 'unknown' })
      throw error
    } finally {
      this.queuePumps.delete(session.id)
      if (!this.busy.has(session.id) && !this.queued(session).some(item => ['dispatching', 'unknown'].includes(item.state))) queueMicrotask(() => { void this.drainQueue(session).catch(() => undefined) })
    }
  }
  private async steerPrompt(session: ManagedSession, input: z.infer<typeof promptSchema>, signal: AbortSignal) {
    const connection = await this.connect(session)
    this.assertPrincipal(session, signal)
    if (!connection.steer) throw new Error('MANAGED_STEERING_NOT_SUPPORTED')
    if (!this.busy.has(session.id) || this.managementFlights.has(session.id)) throw new Error('MANAGED_STEERING_NOT_AVAILABLE')
    const text = input.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
    const images = input.content.filter(part => part.type === 'image')
    const admission = this.store.beginOperation(session, session.id, { operationId: input.requestId, kind: 'steer', input: { text, images: images.map(image => ({ mediaType: image.mediaType, hash: createHash('sha256').update(image.data).digest('hex') })) } })
    if (!admission.execute) {
      if (admission.receipt.status === 'completed') return { accepted: true }
      throw new Error('MANAGED_SEND_OUTCOME_UNKNOWN')
    }
    let content: AdmittedPromptContentPart[]
    try {
      content = images.length ? await this.services.attachments!.admitPromptContent(input.content) : input.content as AdmittedPromptContentPart[]
      this.assertPrincipal(session, signal)
    } catch (error) {
      this.store.completeOperation(session, session.id, input.requestId, 'failed', { code: 'MANAGED_IMAGE_ADMISSION_FAILED' })
      throw error
    }
    const result = await connection.steer({ messageId: input.requestId, text, ...(images.length ? { images: images.map(image => ({ mimeType: image.mediaType, data: image.data })) } : {}) })
    if (result.state === 'rejected') { this.store.completeOperation(session, session.id, input.requestId, 'failed', { code: 'MANAGED_SEND_REJECTED' }); throw new Error('MANAGED_SEND_REJECTED') }
    if (result.state !== 'accepted') throw new Error('MANAGED_SEND_OUTCOME_UNKNOWN')
    this.append(session, 'user/message', { id: input.requestId, role: 'user', content, source: { kind: 'user', rpcId: input.requestId } }, `user:${input.requestId}`)
    this.store.completeOperation(session, session.id, input.requestId, 'completed', { accepted: true })
    return { accepted: true }
  }
  private launchSelection(session: ManagedSession): { profileId: string; locationId: string; ownerFingerprint?: string } {
    return this.records(session).filter(record => record.event.type === 'managed/launch').at(-1)?.event.data as { profileId: string; locationId: string; ownerFingerprint?: string } ?? { profileId: 'host', locationId: 'native' }
  }
  private async management(session: ManagedSession, endpoint: string, request: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const launches = this.services.launches
    const selected = this.launchSelection(session)
    if (launches && !session.providerSessionId && endpoint === 'managedAgent/management') {
      return { operations: ['launch.options', 'launch.select', 'launch.open'], busy: false, state: { lifecycle: this.runtime.status(session.id), questions: [], checkpoints: [] } }
    }
    if (launches && endpoint === 'managedAgent/manage' && ['launch.options', 'launch.select', 'launch.open'].includes(String(request.operation))) {
      const input = managementRequest.parse(request)
      const payload = managementPayload(input.operation, input.payload)
      if (input.operation === 'launch.options') {
        const options = launches.options(session.agentId as 'claude' | 'codex', session.workspacePath)
        return { profiles: options.profiles.map(profile => ({ id: profile.id, name: profile.label })), locations: options.locations.map(location => ({ id: location.id, name: location.label })), selectedProfileId: selected.profileId, selectedLocationId: selected.locationId, canSelect: !session.providerSessionId && !this.opening.has(session.id) && !this.managementFlights.has(session.id) }
      }
      if (input.operation === 'launch.open') {
        const operationId = id.parse(input.operationId)
        const admission = this.store.beginOperation(session, session.id, { operationId, kind: 'launch-open', input: {} })
        if (!admission.execute) {
          if (admission.receipt.status === 'completed') return admission.receipt.result
          throw new Error('MANAGED_OPERATION_OUTCOME_UNKNOWN')
        }
        await this.connect(session)
        this.store.completeOperation(session, session.id, operationId, 'completed', { ready: true })
        this.assertPrincipal(session, signal)
        return { ready: true }
      }
      if (session.providerSessionId || this.opening.has(session.id) || this.busy.has(session.id) || this.managementFlights.has(session.id)) throw new Error('MANAGED_LAUNCH_ALREADY_BOUND')
      const selection = { profileId: String(payload.profileId), locationId: String(payload.locationId) }
      const plan = launches.resolve({ sessionId: session.id, agent: session.agentId, workspacePath: session.workspacePath, selection })
      const operationId = id.parse(input.operationId)
      const admission = this.store.beginOperation(session, session.id, { operationId, kind: 'launch-select', input: selection })
      if (!admission.execute) {
        if (admission.receipt.status !== 'completed') throw new Error('MANAGED_OPERATION_OUTCOME_UNKNOWN')
        return admission.receipt.result
      }
      this.append(session, 'managed/launch', { ...selection, ownerFingerprint: plan.ownerFingerprint }, `launch:${operationId}`)
      this.store.completeOperation(session, session.id, operationId, 'completed', selection)
      return selection
    }
    if (endpoint === 'managedAgent/manage' && (request.operation === 'queue.run' || request.operation === 'queue.remove')) {
      const input = managementRequest.parse(request)
      const payload = managementPayload(input.operation, input.payload)
      const operationId = id.parse(input.operationId)
      const prior = this.store.getOperation(session, session.id, operationId)
      if (!prior) {
        if (input.operation === 'queue.run' && this.busy.has(session.id)) throw new Error('MANAGED_SESSION_BUSY')
        if (input.operation === 'queue.remove' && this.queued(session).find(item => item.requestId === payload.requestId)?.state !== 'queued') throw new Error('MANAGED_QUEUE_ITEM_UNAVAILABLE')
      }
      const admission = this.store.beginOperation(session, session.id, { operationId, kind: `manage:${input.operation}`, input: payload as JsonValue })
      if (!admission.execute) {
        if (admission.receipt.status === 'completed') return admission.receipt.result
        throw new Error('MANAGED_OPERATION_OUTCOME_UNKNOWN')
      }
      if (input.operation === 'queue.run') await this.drainQueue(session)
      else this.append(session, 'managed/queue-status', { requestId: payload.requestId, state: 'removed' }, `queue-removed:${String(payload.requestId)}`)
      const result: JsonValue = input.operation === 'queue.run' ? { accepted: true } : { removed: true }
      this.store.completeOperation(session, session.id, operationId, 'completed', result)
      return result
    }
    const connection = await this.connect(session)
    this.assertPrincipal(session, signal)
    const operations: ManagedManagementOperation[] = ['queue.run', 'queue.remove', ...(connection.managementOperations ?? []), ...(launches ? ['launch.options' as const] : [])]
    const checkpoints = this.records(session).filter(record => record.event.type === 'managed/checkpoint').map(record => record.event.data as { checkpointId: string; throughSeq: number })
    this.liveOperations.set(session.id, operations)
    if (endpoint === 'managedAgent/management') {
      const state = operations.includes('state') ? await connection.manage?.('state', {}) : {}
      this.assertPrincipal(session, signal)
      return { operations, busy: this.busy.has(session.id) || (state as { idle?: string } | null)?.idle === 'busy', state: {
        ...(state && typeof state === 'object' ? state : {}),
        queued: this.queued(session).map(item => ({ requestId: item.requestId, state: item.state, text: item.content.filter(part => part.type === 'text').map(part => part.text).join('\n').slice(0, 1000) })),
        lifecycle: this.runtime.status(session.id),
        unresolvedOperations: this.store.listOperations(session, session.id).filter(receipt => (receipt.status === 'pending' || receipt.status === 'unknown') && (receipt.kind.startsWith('manage:') || ['send', 'steer', 'create-provider', 'launch-open'].includes(receipt.kind))).map(receipt => ({ operationId: receipt.operationId, operation: receipt.kind, status: receipt.status })),
        checkpoints: checkpoints.filter(point => !Array.isArray((state as { checkpoints?: unknown[] } | null)?.checkpoints) || ((state as { checkpoints: Array<{ id?: string }> }).checkpoints).some(provider => provider.id === point.checkpointId)).map((point, index) => ({ id: point.checkpointId, title: `Checkpoint ${index + 1}` })),
        questions: [...(this.questions.get(session.id)?.values() ?? [])],
      } }
    }
    const input = managementRequest.parse(request)
    const payload = managementPayload(input.operation, input.payload)
    if (!operations.includes(input.operation) || !connection.manage) throw new Error('MANAGED_CAPABILITY_UNAVAILABLE')
    if (input.operation === 'state') return this.management(session, 'managedAgent/management', { sessionId: session.id }, signal)
    if (managementReads.has(input.operation)) {
      const result = await connection.manage(input.operation, payload)
      this.assertPrincipal(session, signal)
      return result
    }
    if ((input.operation === 'rewind' || input.operation === 'fork') && payload.checkpointId !== undefined && !checkpoints.some(point => point.checkpointId === payload.checkpointId)) throw new Error('MANAGED_CHECKPOINT_NOT_FOUND')
    const operationId = id.parse(input.operationId)
    if (this.managementFlights.has(session.id) || this.optionFlights.has(session.id)) throw new Error('MANAGED_SESSION_BUSY')
    if (!managementWhileBusy.has(input.operation) && this.busy.has(session.id)) throw new Error('MANAGED_SESSION_BUSY')
    // Any unresolved mutation blocks a second mutation. An uncertain provider
    // outcome must be reconciled, never guessed from a disconnected requester.
    if (this.store.listOperations(session, session.id).some(receipt => receipt.operationId !== operationId && receipt.kind.startsWith('manage:') && (receipt.status === 'pending' || receipt.status === 'unknown'))) throw new Error('MANAGED_OPERATION_OUTCOME_UNKNOWN')
    this.managementFlights.add(session.id)
    try {
      const admission = this.store.beginOperation(session, session.id, { operationId, kind: `manage:${input.operation}`, input: payload as JsonValue })
      if (!admission.execute) {
        if (admission.receipt.status === 'completed') return admission.receipt.result
        throw new Error(admission.receipt.status === 'failed' ? 'MANAGED_OPERATION_REJECTED' : 'MANAGED_OPERATION_OUTCOME_UNKNOWN')
      }
      this.assertPrincipal(session, signal)
      const raw = await connection.manage(input.operation, { ...payload, operationId })
      // A provider may already have acted even if the caller disconnected. Finish
      // the Host journal; transport authorization still controls response delivery.
      let result = JSON.parse(JSON.stringify(raw ?? { accepted: true })) as JsonValue
      if (input.operation === 'fork') {
        const providerSessionId = id.parse((raw as { providerSessionId?: unknown })?.providerSessionId)
        if (providerSessionId === session.providerSessionId) throw new Error('MANAGED_FORK_ID_CONFLICT')
        const entries: Array<{ eventId: string; payload: JsonValue }> = [{ eventId: 'fork-launch', payload: { type: 'managed/launch', data: this.launchSelection(session) } }]
        const permission = this.records(session).filter(record => record.event.type === 'managed/permission').at(-1)
        if (permission) entries.push({ eventId: 'fork-permission', payload: JSON.parse(JSON.stringify({ type: permission.event.type, data: permission.event.data })) as JsonValue })
        const cutoff = payload.checkpointId === undefined ? Infinity : checkpoints.find(point => point.checkpointId === payload.checkpointId)!.throughSeq
        let active = [] as NativeRecord[]
        for (const record of this.records(session)) {
          if (record.event.seq > cutoff) break
          if (record.event.type === 'managed/rewind') active = active.filter(prior => prior.event.seq <= (record.event.data as { throughSeq: number }).throughSeq)
          else if (!record.event.type.startsWith('managed/')) active.push(record)
        }
        const mapping = new Map<number, number>()
        for (const record of active) {
          entries.push({ eventId: `fork-record:${record.event.seq}`, payload: JSON.parse(JSON.stringify({ type: record.event.type, data: record.event.data })) as JsonValue })
          mapping.set(record.event.seq, entries.length - 1)
        }
        for (const point of checkpoints.filter(point => point.throughSeq <= cutoff)) {
          const preceding = active.filter(record => record.event.seq <= point.throughSeq).at(-1)
          if (preceding || point.throughSeq === -1) entries.push({ eventId: `checkpoint:${point.checkpointId}`, payload: { type: 'managed/checkpoint', data: { checkpointId: point.checkpointId, throughSeq: preceding ? mapping.get(preceding.event.seq)! : -1 } } })
        }
        const selected = this.selection(session)
        if (selected) entries.push({ eventId: 'fork-model', payload: { type: 'model/selection', data: selected } })
        const child = this.store.commitFork(session, session.id, operationId, providerSessionId, entries)
        this.sessions.set(child.id, child)
        result = { sessionId: child.id, providerSessionId }
      } else if (input.operation === 'rewind') {
        const value = raw as { providerSessionId?: unknown; replacesProviderSessionId?: unknown }
        const replacement = id.parse(value.providerSessionId ?? session.providerSessionId)
        if (value.replacesProviderSessionId !== undefined && value.replacesProviderSessionId !== session.providerSessionId) throw new Error('MANAGED_PROVIDER_SESSION_CONFLICT')
        await this.runtime.close(session.id)
        this.store.commitProviderReplacement(session, session.id, operationId, session.providerSessionId!, replacement, result, {
          eventId: `rewind:${operationId}`, payload: { type: 'managed/rewind', data: { checkpointId: String(payload.checkpointId), throughSeq: checkpoints.find(point => point.checkpointId === payload.checkpointId)!.throughSeq, operationId } },
        })
        this.questions.delete(session.id)
        this.liveOperations.delete(session.id)
        return result
      } else if (input.operation === 'question.answer') {
        this.questions.get(session.id)?.delete(String(payload.requestId))
      } else if (input.operation === 'rename') {
        this.rename(session, String(payload.title), 'user')
      } else if (input.operation === 'option.set') {
        if (payload.key === 'permissionMode') {
          this.append(session, 'managed/permission', { permissionMode: payload.value }, `permission:${operationId}`)
          if (session.agentId === 'codex') { await this.runtime.close(session.id); await this.connect(session) }
        }
        if (payload.key === 'model' || payload.key === 'reasoningEffort') {
          const selected = this.selection(session) ?? (connection.defaultModel ? { provider: session.agentId, ...connection.defaultModel } : undefined)
          if (selected) this.append(session, 'model/selection', { ...selected, [String(payload.key)]: payload.value })
        }
      }
      this.store.completeOperation(session, session.id, operationId, 'completed', result)
      for (const callback of this.listeners) callback()
      return result
    } catch (error) {
      if ((error as { definiteRejection?: boolean } | null)?.definiteRejection === true) this.store.completeOperation(session, session.id, operationId, 'failed', { code: 'MANAGED_OPERATION_REJECTED' })
      throw error
    } finally { this.managementFlights.delete(session.id) }
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
      if (this.services.launches && !session.providerSessionId) continue
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
        queue.push({ type: 'projection', sessionId: session.id, seq: projection.asOfSeq, changes: Object.entries(projection.values).map(([key, val]) => ({ key, val })) })
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
      hasMore: records.length > 100, projections: this.summary(session).projections, assistantStream: this.stream(session).snapshot() })
    const onFrame = (frame: unknown) => {
      try { this.assertPrincipal(session, signal); queue.push({ type: 'assistant-stream', frame }) } catch { queue.close() }
    }
    let followers = this.streamListeners.get(session.id)
    if (!followers) { followers = new Set(); this.streamListeners.set(session.id, followers) }
    followers.add(onFrame)
    const unsubscribe = this.store.subscribe((owner, event) => {
      if (owner.id !== session.id) return
      const principal = this.principal()
      if (!principal || principal.hostId !== owner.hostId || principal.ownerId !== owner.ownerId) { queue.close(); return }
      const data = event.payload as { type: string; data: unknown }
      queue.push({ type: 'event', event: { type: data.type, seq: event.sequence - 1, time: event.createdAt,
        data: adaptEventData(data.type, data.data, 'v3'), ...(['user/message', 'assistant/message', 'tool/result'].includes(data.type) ? { surfaceOp: 'append' } : {}) } })
    })
    return queue.iterate(() => { unsubscribe(); followers!.delete(onFrame) })
  }
  async close(): Promise<void> {
    this.closedSignal.abort(); this.unsubscribe(); this.listeners.clear()
    await Promise.allSettled(this.titleJobs)
    await this.runtime.closeAll()
    this.store.close()
  }
}
