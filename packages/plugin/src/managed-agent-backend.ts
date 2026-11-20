import type { ManagedLaunchRegistry } from './managed-agents/launch.js'
import { answersSchema, validateAnswers, type ManagedQuestion } from './managed-agents/questions.js'
import { ManagedAssistantStream } from './managed-agents/stream.js'
import type { ManagedTitleInput } from './managed-agents/title.js'
import { randomUUID, createHash } from 'node:crypto'
import { z } from 'zod'
import { ManagedSessionStore, type ManagedSession, type ManagedSessionScope, type JsonValue } from './managed-session-store/index.js'
import { ManagedAgentRuntime } from './managed-agents/runtime.js'
import type { ManagedAgentConnection, ManagedAgentEvent } from './managed-agents/types.js'
import type { TypertGatewayRequest, TypertRpcResult } from './typert-gateway-contract.js'
import { AsyncValueQueue, carrierArgs, requestArg } from './codex/virtual-contract.js'
import { adaptEventData } from './codex/virtual-history.js'

const id = z.string().min(1).max(512)
const createSchema = z.object({ workspaceId: id, agentId: id, operationId: id, profileId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/).optional() }).strict()
const promptSchema = z.object({ sessionId: id, requestId: id, content: z.array(z.object({ type: z.literal('text'), text: z.string().max(262144) }).strict()).min(1).max(16), mode: z.enum(['queue', 'steer']).optional() })
type Workspace = { workspaceId: string; path: string }
type Principal = { ownerId: string; hostId: string }
type NativeRecord = { type: 'event'; event: { type: string; seq: number; time: number; data: unknown; surfaceOp?: 'append' } }

/** One Host owns execution; callers only own subscriptions and scoped operations. */
export class ManagedAgentBackend {
  private readonly questions = new Map<string, Map<string, { requestId: string; title: string; questions: ManagedQuestion[] }>>()
  private readonly answerFlights = new Set<string>()
  private readonly queuePumps = new Set<string>()
  private readonly streams = new Map<string, ManagedAssistantStream>()
  private readonly streamListeners = new Map<string, Set<(frame: unknown) => void>>()
  private readonly steps = new Map<string, number>()
  private principalTimer?: ReturnType<typeof setInterval>
  private publishedPrincipal?: string
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

  private readonly titleJobs = new Set<Promise<void>>()

  constructor(
    readonly store: ManagedSessionStore,
    readonly runtime: ManagedAgentRuntime,
    private readonly principal: () => Principal | undefined,
    private readonly workspaces: (signal?: AbortSignal) => Promise<readonly Workspace[]>,
    private readonly services: { launches?: ManagedLaunchRegistry; idleTimeoutMs?: number; nativeArchived?: (signal: AbortSignal) => Promise<string[]>; generateTitle?: (input: ManagedTitleInput) => Promise<string> } = {},
  ) {
    runtime.startIdleMaintenance(services.idleTimeoutMs ?? 0, sessionId => {
      const session = this.sessions.get(sessionId)
      if (!session || this.closedSignal.signal.aborted || this.busy.has(sessionId) || this.opening.has(sessionId) || this.queuePumps.has(sessionId) || this.optionFlights.has(sessionId) || this.questions.get(sessionId)?.size) return false
      if ([...this.approvals.values()].some(item => item.session.id === sessionId) || this.queued(session).some(item => ['queued', 'dispatching', 'unknown'].includes(item.state))) return false
      return !this.store.listOperations(session, session.id).some(item => ['pending', 'unknown'].includes(item.status))
    })
    this.unsubscribe = store.subscribe(() => { for (const callback of this.listeners) callback() })
  }

  ownsSession(sessionId: string): boolean { return this.sessions.has(sessionId) }
  subscribeCatalog(callback: () => void): () => void {
    if (this.closedSignal.signal.aborted) return () => {}
    this.listeners.add(callback)
    // Server authentication resumes asynchronously after Host startup. Disk
    // writes alone cannot invalidate the initially empty native sidebar.
    // One lightweight identity check per backend; no disk/network polling.
    this.principalTimer ??= setInterval(() => {
      const principal = this.principal()
      const key = principal ? JSON.stringify([principal.ownerId, principal.hostId]) : undefined
      if (key === this.publishedPrincipal) return
      this.publishedPrincipal = key
      this.sessions.clear()
      for (const listener of this.listeners) listener()
    }, 1000)
    this.principalTimer.unref?.()
    return () => {
      this.listeners.delete(callback)
      if (!this.listeners.size) {
        clearInterval(this.principalTimer)
        this.principalTimer = undefined
        this.publishedPrincipal = undefined
      }
    }
  }
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
        inbox: { 'next-turn': this.queued(session).filter(item => item.state === 'queued').map(item => this.queueMessage(item)), 'next-step': [] },
        title, managedAgent: this.agentIdentity(session.agentId),
        modelSelection: { lastUsed: selected ?? null, next: selected ?? null },
        sessionListMetadata: { blank, lastPromptAt: prompts.at(-1)?.event.time ?? null },
      } } }
  }
  /** Transport capabilities describe implemented endpoints, not Orca adapter aspirations.
   * Registration alone does not prove a CLI is installed or its credentials work. */
  private agentIdentity(agentId: string) {
    const definition = this.runtime.registry.definition(agentId)
    return { agentId, name: definition?.title ?? agentId, icon: definition?.icon ?? agentId,
      registered: definition !== null, availability: 'unverified' as const,
      capabilities: {
        textPrompts: true, imagePrompts: false, fileAttachments: false,
        steering: false, queueWhileBusy: true, modelSelection: true,
        reasoningEffort: agentId === 'codex', rename: true, archive: true, unarchive: true,
        pin: false, move: false, fork: false, rewind: false, compact: false,
        threadGoal: false, contextUsage: false,
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
        const title = await generate({ environment: this.services.launches?.resolve({ sessionId: session.id, agent: session.agentId, workspacePath: session.workspacePath, selection: this.launchSelection(session), previousFingerprint: this.launchSelection(session).ownerFingerprint }).environment(), agent: session.agentId, cwd: session.workspacePath, text: content, model, signal: this.closedSignal.signal })
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
      if (!this.busy.has(session.id)) return
      this.stream(session).accept(event.itemId ?? randomUUID(), event.type.startsWith('text') ? 'text' : 'reasoning', event.text,
        event.type === 'text' || event.type === 'reasoning', this.records(session).length - 1, turn, this.steps.get(session.id) ?? 1)
    } else if (event.type === 'question') {
      let pending = this.questions.get(session.id); if (!pending) { pending = new Map(); this.questions.set(session.id, pending) }
      pending.set(event.requestId, { requestId: event.requestId, title: event.title, questions: event.questions })
      // Only live requests can be answered; persisted entries never re-enable a dead request.
      this.append(session, 'managed/question-opened', { requestId: event.requestId })
    } else if (event.type === 'question-closed') {
      this.questions.get(session.id)?.delete(event.requestId)
      this.append(session, 'managed/question-closed', { requestId: event.requestId })
    } else if (event.type === 'tool') {
      this.flushStream(session, true)
      if (event.status === 'running') this.append(session, 'tool/call', { turn, step: this.steps.get(session.id) ?? 1, callId: event.itemId, name: event.name, arguments: JSON.stringify(event.data) })
      else this.append(session, 'tool/result', { turn, step: this.steps.get(session.id) ?? 1, message: { id: `${event.itemId}:result`, role: 'user',
        content: [{ type: 'tool-result', toolCallId: event.itemId, content: [{ type: 'text', text: JSON.stringify(event.data) }] }], source: { kind: 'tool', callId: event.itemId } } })
    } else if (event.type === 'approval') {
      const eventId = `managed-agent:${session.id}:${event.requestId}`
      this.approvals.set(eventId, { session, requestId: event.requestId, choices: event.choices, title: event.title, data: event.data })
      this.publishApproval(eventId, this.approvals.get(eventId)!)
    } else if (event.type === 'turn-completed') {
      if (!this.busy.has(session.id)) return
      this.flushStream(session)
      for (const [key, approval] of this.approvals) if (approval.session.id === session.id) this.approvals.delete(key)
      this.busy.delete(session.id)
      this.questions.delete(session.id)
      this.append(session, 'step/end', { turn, step: this.steps.get(session.id) ?? 1 })
      if (event.status !== 'completed') this.append(session, 'managed/queue-paused', { paused: true })
      this.scheduleQueue(session)
      this.append(session, 'turn/end', { turn, reason: event.status === 'completed' ? { kind: 'completed' }
        : event.status === 'cancelled' ? { kind: 'interrupted' } : { kind: 'error', error: { code: 'MANAGED_TURN_FAILED', message: 'Agent turn failed.' } } })
    } else if (event.type === 'error' || event.type === 'unavailable') {
      this.flushStream(session, true)
      this.append(session, 'managed/queue-paused', { paused: true })
      const wasBusy = this.busy.has(session.id)
      if (event.type === 'unavailable') {
        this.busy.delete(session.id)
        this.questions.delete(session.id)
        for (const [key, approval] of this.approvals) if (approval.session.id === session.id) this.approvals.delete(key)
      }
      this.append(session, 'assistant/message', { turn, step: this.steps.get(session.id) ?? 1, message: { id: randomUUID(), role: 'assistant',
        content: [{ type: 'text', text: `Agent error: ${event.code}` }], source: { kind: 'model', provider: session.agentId, model: session.agentId } } })
      if (event.type === 'unavailable' && wasBusy) {
        this.append(session, 'step/end', { turn, step: this.steps.get(session.id) ?? 1 })
        this.append(session, 'turn/end', { turn, reason: { kind: 'error', error: { code: event.code, message: 'Agent process became unavailable.' } } })
      }
    }
  }
  private stream(session: ManagedSession): ManagedAssistantStream {
    let stream = this.streams.get(session.id)
    if (!stream) { stream = new ManagedAssistantStream(frame => { for (const listener of this.streamListeners.get(session.id) ?? []) listener(frame) }); this.streams.set(session.id, stream) }
    return stream
  }
  private flushStream(session: ManagedSession, nextStep = false): void {
    const turn = this.turns.get(session.id) ?? 1, step = this.steps.get(session.id) ?? 1
    const flushed = this.streams.get(session.id)?.flush(content => {
      this.append(session, 'assistant/message', { turn, step, message: { id: randomUUID(), role: 'assistant', content,
        source: { kind: 'model', provider: session.agentId, model: this.selection(session)?.model ?? session.agentId } } })
      return this.records(session).length - 1
    })
    if (flushed && nextStep) {
      this.append(session, 'step/end', { turn, step })
      this.steps.set(session.id, step + 1)
      this.append(session, 'step/start', { turn, step: step + 1 })
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
      let launch = this.launchSelection(session)
      const plan = this.services.launches?.resolve({ sessionId: session.id, agent: session.agentId, workspacePath: session.workspacePath, selection: launch, previousFingerprint: launch.ownerFingerprint })
      if (session.providerSessionId && launch.profileId !== 'host' && !launch.ownerFingerprint) throw new Error('MANAGED_PROFILE_BINDING_MISSING')
      if (plan && !launch.ownerFingerprint) { launch = { ...launch, ownerFingerprint: plan.ownerFingerprint }; this.append(session, 'managed/launch', launch, 'launch-binding') }
      if (session.providerSessionId && launch.profileId !== 'host' && !launch.ownerFingerprint) throw new Error('MANAGED_PROFILE_BINDING_MISSING')
      const attempts = this.store.listOperations(session, session.id).filter(item => item.kind === 'create-provider')
      if (!session.providerSessionId && attempts.some(item => item.status !== 'failed')) throw new Error('MANAGED_PROVIDER_CREATE_UNCERTAIN')
      const createId = attempts.length ? `provider-create:${attempts.length}` : 'provider-create'
      if (!session.providerSessionId) {
        const admission = this.store.beginOperation(session, session.id, { operationId: createId, kind: 'create-provider', input: { agent: session.agentId } })
        if (!admission.execute) throw new Error('MANAGED_PROVIDER_CREATE_UNCERTAIN')
      }
      const selected = this.selection(session)
      let connection: ManagedAgentConnection
      try { connection = await this.runtime.open({ launch, launchFingerprint: launch.ownerFingerprint, sessionId: session.id, agent: session.agentId, workspacePath: session.workspacePath,
        ...(selected ? { model: selected.model, ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}) } : {}),
        ...(session.providerSessionId ? { providerSessionId: session.providerSessionId } : {}) }, event => this.emit(session, event)) }
      catch (error) { if (!session.providerSessionId && (error as { cleanupConfirmed?: boolean }).cleanupConfirmed) this.store.completeOperation(session, session.id, createId, 'failed', { code: 'MANAGED_START_CLEAN_FAILURE' }); throw error }
      this.store.bindProviderSession(session, session.id, connection.providerSessionId)
      if (!session.providerSessionId) this.store.completeOperation(session, session.id, createId, 'completed', { providerSessionId: connection.providerSessionId })
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
    if (endpoint === 'managedAgent/agents') return { items: this.runtime.registry.definitions().map(definition => ({ id: definition.agent, profiles: this.services.launches?.options(definition.agent) ?? [{ id: 'host', label: 'Computer configuration' }], ...this.agentIdentity(definition.agent), available: true })) }
    if (endpoint === 'managedAgent/create') {
      const input = createSchema.parse(request)
      if (!this.runtime.registry.definition(input.agentId)) throw new Error('MANAGED_AGENT_UNAVAILABLE')
      const expected = this.scope(input.workspaceId)
      const workspace = (await this.workspaces(signal)).find(item => item.workspaceId === input.workspaceId)
      this.assertPrincipal(expected, signal)
      if (!workspace) throw new Error('MANAGED_WORKSPACE_NOT_FOUND')
      const profileId = input.profileId ?? 'host'
      if (!(this.services.launches?.options(input.agentId) ?? [{ id: 'host' }]).some(profile => profile.id === profileId)) throw new Error('MANAGED_PROFILE_UNAVAILABLE')
      const session = this.store.createSession(expected, { ...input, providerId: input.agentId, workspacePath: workspace.path })
      const priorLaunch = this.launchSelection(session)
      if (this.records(session).some(record => record.event.type === 'managed/launch') && priorLaunch.profileId !== profileId) throw new Error('MANAGED_OPERATION_CONFLICT')
      if (!this.records(session).some(record => record.event.type === 'managed/launch')) this.append(session, 'managed/launch', { profileId }, 'initial-launch')
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
    if (endpoint === 'workspace/archiveSession' || endpoint === 'workspace/unarchiveSession') {
      const archived = endpoint === 'workspace/archiveSession'
      const native = await this.services.nativeArchived?.(signal) ?? []
      this.assertPrincipal(session, signal)
      if (archived && this.busy.has(session.id) && request.stopActivity !== true) throw Object.assign(new Error('workspace/session-active'), { details: { sessionId: session.id, activity: [{ kind: 'turn' }] } })
      if (archived) this.append(session, 'managed/queue-paused', { paused: true })
      if (archived && this.busy.has(session.id)) {
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
      if (session.archived) throw new Error('MANAGED_SESSION_ARCHIVED')
      if (request.fileReceiptIds !== undefined && (!Array.isArray(request.fileReceiptIds) || request.fileReceiptIds.length > 0)) throw new Error('MANAGED_ATTACHMENTS_NOT_SUPPORTED')
      const input = promptSchema.parse(request)
      const text = input.content.map(item => item.text).join('\n')
      if (!text.trim()) throw new Error('MANAGED_EMPTY_PROMPT')
      if (input.mode === 'steer') throw new Error('MANAGED_STEERING_NOT_SUPPORTED')
      const queued = this.queued(session).find(item => item.requestId === input.requestId)
      if (queued && !this.queuePumps.has(session.id)) return this.enqueuePrompt(session, input)
      if (input.mode === 'queue' && this.busy.has(session.id)) return this.enqueuePrompt(session, input)
      if (!this.queuePumps.has(session.id) && this.queued(session).some(item => ['queued', 'dispatching', 'unknown'].includes(item.state))) return this.enqueuePrompt(session, input)
      const previous = this.store.getOperation(session, session.id, input.requestId)
      if (!previous && (this.busy.has(session.id) || this.optionFlights.has(session.id) || this.store.listOperations(session, session.id).some(operation =>
        operation.kind === 'send' && (operation.status === 'pending' || operation.status === 'unknown')))) throw new Error('MANAGED_SESSION_BUSY')
      const admission = this.store.beginOperation(session, session.id, { operationId: input.requestId, kind: 'send', input: { text } })
      if (!admission.execute) {
        if (admission.receipt.status === 'completed') return { accepted: true }
        if (admission.receipt.status === 'failed') throw new Error('MANAGED_SEND_REJECTED')
        throw new Error('MANAGED_SEND_OUTCOME_UNKNOWN')
      }
      if (!this.queuePumps.has(session.id) && this.records(session).some(record => record.event.type === 'managed/queue-paused')) this.append(session, 'managed/queue-paused', { paused: false })
      this.busy.add(session.id)
      const turn = this.records(session).filter(item => item.event.type === 'turn/start').length + 1
      this.turns.set(session.id, turn)
      this.steps.set(session.id, 1)
      this.stream(session)
      this.append(session, 'user/message', { id: input.requestId, role: 'user', content: input.content, source: { kind: 'user', rpcId: input.requestId } }, `user:${input.requestId}`)
      const records = this.records(session)
      if (session.title === 'New conversation' && !records.some(record => record.event.type === 'session/title')) {
        const first = records.find(record => record.event.type === 'user/message')
        const title = this.promptTitle(first?.event.data)
        if (title && first) this.rename(session, title, 'fallback', [first.event.seq])
      }
      this.append(session, 'turn/start', { turn })
      this.append(session, 'step/start', { turn, step: this.steps.get(session.id) ?? 1 })
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
        this.generateTitle(session, this.selection(session)?.model ?? connection.defaultModel?.model)
        if (!this.busy.has(session.id)) this.scheduleQueue(session)
        return { accepted: true }
      } catch (error) {
        if (!dispatched) {
          this.store.completeOperation(session, session.id, input.requestId, 'failed', { code: 'MANAGED_START_FAILED' })
          if (this.busy.has(session.id)) this.emit(session, { type: 'turn-completed', status: 'failed' })
        }
        throw error
      }
    }
    if (endpoint === 'session/cancel') {
      this.append(session, 'managed/queue-paused', { paused: true })
      if (this.busy.has(session.id)) { const connection = await this.connect(session); this.assertPrincipal(session, signal); await connection.cancel() }
      return { accepted: true }
    }
    if (endpoint === 'session/updateQueue') {
      const itemId = id.parse(request.itemId), item = this.queued(session).find(item => item.requestId === itemId)
      if (!item || item.state !== 'queued') throw new Error('MANAGED_QUEUE_ITEM_UNAVAILABLE')
      const action = z.discriminatedUnion('kind', [z.object({ kind: z.literal('remove') }).strict(), z.object({ kind: z.literal('edit'), content: promptSchema.shape.content }).strict()]).parse(request.action)
      const pending = this.queued(session).filter(item => item.state === 'queued'), index = pending.findIndex(item => item.requestId === itemId)
      if (action.kind === 'edit' && !action.content.some(block => block.text.trim())) throw new Error('MANAGED_EMPTY_PROMPT')
      this.append(session, action.kind === 'remove' ? 'managed/queue-status' : 'managed/queue-edit', action.kind === 'remove' ? { requestId: itemId, state: 'removed' } : { requestId: itemId, content: action.content })
      this.append(session, 'agent/inbox/spliced', { target: 'next-turn', start: index, removedCount: 1,
        inserted: action.kind === 'remove' ? [] : [this.queueMessage({ ...item, content: action.content })], outcome: 'canceled' })
      return { accepted: true }
    }
    if (endpoint === 'managedAgent/resumeQueue') {
      if (session.archived) throw new Error('MANAGED_SESSION_ARCHIVED')
      if (this.queued(session).some(item => ['dispatching', 'unknown'].includes(item.state))) throw new Error('MANAGED_SEND_OUTCOME_UNKNOWN')
      this.stream(session); this.append(session, 'managed/queue-paused', { paused: false }); this.scheduleQueue(session); return { accepted: true }
    }
    if (endpoint === 'managedAgent/chatState') return { questions: [...(this.questions.get(session.id)?.values() ?? [])], queue: this.queued(session).filter(item => !['sent', 'removed'].includes(item.state)), paused: this.queuePaused(session) }

    if (endpoint === 'managedAgent/answerQuestion') {
      const input = z.object({ sessionId: id, requestId: id, answers: answersSchema }).strict().parse(request)
      const operationId = `answer:${createHash('sha256').update(input.requestId).digest('hex')}`
      const previous = this.store.getOperation(session, session.id, operationId)
      const question = this.questions.get(session.id)?.get(input.requestId)
      if (!previous && !question) throw new Error('MANAGED_QUESTION_EXPIRED')
      if (question) validateAnswers(question.questions, input.answers)
      if (this.answerFlights.has(operationId)) throw new Error('MANAGED_ANSWER_PENDING')
      this.answerFlights.add(operationId)
      try {
        const admission = this.store.beginOperation(session, session.id, { operationId, kind: 'question-answer', input: { requestId: input.requestId, digest: createHash('sha256').update(JSON.stringify(Object.entries(input.answers).sort())).digest('hex') } })
        if (!admission.execute) {
          if (admission.receipt.status === 'completed') return { accepted: true }
          throw new Error('MANAGED_ANSWER_OUTCOME_UNKNOWN')
        }
        const connection = await this.runtime.connection(session.id)
        this.assertPrincipal(session, signal)
        if (!connection.answerQuestion || !this.questions.get(session.id)?.has(input.requestId)) throw new Error('MANAGED_QUESTION_EXPIRED')
        await connection.answerQuestion(input.requestId, input.answers)
        this.store.completeOperation(session, session.id, operationId, 'completed', { accepted: true })
        this.questions.get(session.id)?.delete(input.requestId)
        return { accepted: true }
      } finally { this.answerFlights.delete(operationId) }
    }
    if (endpoint === 'managedAgent/models' || endpoint === 'session/models' || endpoint === 'session/modelCatalog') {
      const catalog = await this.models(session, request.refresh === true)
      return { ...catalog, current: this.selection(session), routable: catalog.groups.length > 0, routableProviders: [session.agentId] }
    }
    if (endpoint === 'session/initializeDefaultModel') { if (!this.selection(session)) await this.models(session); return { selected: this.selection(session) } }
    if (endpoint === 'managedAgent/selectModel' || endpoint === 'session/selectModel') {
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
  private queued(session: ManagedSession): Array<{ requestId: string; content: Array<{ type: 'text'; text: string }>; state: string }> {
    const items = new Map<string, { requestId: string; content: Array<{ type: 'text'; text: string }>; state: string }>()
    for (const { event } of this.records(session)) {
      const value = event.data as { requestId: string; content: Array<{ type: 'text'; text: string }>; state: string }
      if (event.type === 'managed/queued') items.set(value.requestId, { ...value, state: 'queued' })
      if (event.type === 'managed/queue-status' && items.has(value.requestId)) items.get(value.requestId)!.state = value.state
      if (event.type === 'managed/queue-edit' && items.has(value.requestId)) items.get(value.requestId)!.content = value.content
    }
    return [...items.values()]
  }
  private queueMessage(item: { requestId: string; content: Array<{ type: 'text'; text: string }> }) {
    return { id: item.requestId, role: 'user', content: item.content, source: { kind: 'user', rpcId: item.requestId } }
  }
  private queuePaused(session: ManagedSession): boolean {
    const record = this.records(session).filter(item => item.event.type === 'managed/queue-paused').at(-1)
    // A new Host must not silently execute a queue left by a previous process.
    return !this.streams.has(session.id) || (record?.event.data as { paused?: boolean } | undefined)?.paused === true
  }
  private enqueuePrompt(session: ManagedSession, input: z.infer<typeof promptSchema>) {
    const existing = this.records(session).find(item => item.event.type === 'managed/queued' && (item.event.data as { requestId?: string }).requestId === input.requestId)
    if (existing) {
      if (JSON.stringify((existing.event.data as { content: unknown }).content) !== JSON.stringify(input.content)) throw new Error('MANAGED_OPERATION_CONFLICT')
      return { accepted: true, queued: true }
    }
    if (this.queued(session).filter(item => ['queued', 'dispatching', 'unknown'].includes(item.state)).length >= 20) throw new Error('MANAGED_QUEUE_FULL')
    if (this.store.getOperation(session, session.id, input.requestId)) throw new Error('MANAGED_OPERATION_CONFLICT')
    const index = this.queued(session).filter(item => item.state === 'queued').length
    this.append(session, 'managed/queued', { requestId: input.requestId, content: input.content }, `queued:${createHash('sha256').update(input.requestId).digest('hex')}`)
    this.append(session, 'agent/inbox/spliced', { target: 'next-turn', start: index, removedCount: 0, inserted: [this.queueMessage(input)] })
    if (!this.busy.has(session.id)) this.scheduleQueue(session)
    return { accepted: true, queued: true }
  }
  private scheduleQueue(session: ManagedSession): void { queueMicrotask(() => { void this.drainQueue(session).catch(() => undefined) }) }
  private async drainQueue(session: ManagedSession): Promise<void> {
    if (this.closedSignal.signal.aborted || this.queuePumps.has(session.id) || this.busy.has(session.id) || this.queuePaused(session) || this.optionFlights.has(session.id)) return
    this.assertPrincipal(session)
    const items = this.queued(session)
    if (items.some(item => ['dispatching', 'unknown'].includes(item.state))) return
    if (this.store.listOperations(session, session.id).some(item => item.kind === 'send' && ['pending', 'unknown'].includes(item.status))) return
    const item = items.find(item => item.state === 'queued'); if (!item) return
    this.queuePumps.add(session.id)
    try {
      const current = await this.requireSession(session.id, this.closedSignal.signal)
      if (current.archived) return
      if (this.busy.has(session.id) || this.queuePaused(session) || this.queued(session).find(row => row.requestId === item.requestId)?.state !== 'queued') return
      this.append(session, 'managed/queue-status', { requestId: item.requestId, state: 'dispatching' })
      this.append(session, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'claimed' })
      await this.call('session/prompt', { sessionId: session.id, requestId: item.requestId, content: item.content }, this.closedSignal.signal)
      this.append(session, 'managed/queue-status', { requestId: item.requestId, state: 'sent' })
    } catch {
      const receipt = this.store.getOperation(session, session.id, item.requestId)
      this.append(session, 'managed/queue-status', { requestId: item.requestId, state: receipt?.status === 'failed' ? 'rejected' : 'unknown' })
      this.append(session, 'managed/queue-paused', { paused: true })
    } finally { this.queuePumps.delete(session.id); if (!this.busy.has(session.id)) this.scheduleQueue(session) }
  }
  private launchSelection(session: ManagedSession): { profileId: string; ownerFingerprint?: string } {
    return this.records(session).filter(item => item.event.type === 'managed/launch').at(-1)?.event.data as { profileId: string; ownerFingerprint?: string } ?? { profileId: 'host' }
  }
  private selection(session: ManagedSession): { provider: string; model: string; reasoningEffort?: string } | undefined {
    return this.records(session).reverse().find(record => record.event.type === 'model/selection')?.event.data as { provider: string; model: string; reasoningEffort?: string } | undefined
  }
  private async models(session: ManagedSession, refresh = false) {
    const connection = await this.connect(session)
    const raw = await connection.models?.({ refresh })
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
    signal.throwIfAborted()
    // Each workspace/profile owns its own directory. Enumerating history must
    // not launch Agents, mix accounts or inject another Agent's load error.
    return { groups: [], failures: [], routableProviders: [] }
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
      hasMore: records.length > 100, projections: this.summary(session).projections, assistantStream: this.streams.get(session.id)?.snapshot() ?? { revision: 0 } })
    let followers = this.streamListeners.get(session.id)
    if (!followers) { followers = new Set(); this.streamListeners.set(session.id, followers) }
    const onFrame = (frame: unknown) => { try { this.assertPrincipal(session, signal); queue.push({ type: 'assistant-stream', frame }) } catch { queue.close() } }
    followers.add(onFrame)
    const unsubscribe = this.store.subscribe((owner, event) => {
      if (owner.id !== session.id) return
      const principal = this.principal()
      if (!principal || principal.hostId !== owner.hostId || principal.ownerId !== owner.ownerId) { queue.close(); return }
      const data = event.payload as { type: string; data: unknown }
      queue.push({ type: 'event', event: { type: data.type, seq: event.sequence - 1, time: event.createdAt,
        data: adaptEventData(data.type, data.data, 'v3'), ...(['user/message', 'assistant/message', 'tool/result'].includes(data.type) ? { surfaceOp: 'append' } : {}) } })
    })
    return queue.iterate(() => { unsubscribe(); followers!.delete(onFrame); if (!followers!.size) this.streamListeners.delete(session.id) })
  }
  async close(): Promise<void> {
    this.closedSignal.abort(); this.unsubscribe(); this.listeners.clear(); clearInterval(this.principalTimer); this.streamListeners.clear(); this.streams.clear()
    await Promise.allSettled(this.titleJobs)
    await this.runtime.closeAll()
    this.store.close()
  }
}
