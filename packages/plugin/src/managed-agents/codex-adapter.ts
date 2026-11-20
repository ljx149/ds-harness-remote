import { defaultManagedLaunchRegistry, type ManagedLaunchRegistry } from './launch.js'
import { questionsSchema, validateAnswers, type ManagedQuestion } from './questions.js'
import { randomUUID } from 'node:crypto'
import { CodexAppServerClient, type CodexAppServerLike } from '../codex/app-server.js'
import type { ManagedAgentAdapter, ManagedAgentConnection, ManagedAgentEmit, ManagedAgentOpen } from './types.js'

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

type Measure = <T>(stage: string, work: () => Promise<T>) => Promise<T>
/** Opt-in diagnostics contain no paths, request bodies, model names or credentials. */
function timings(): Measure {
  const trace = randomUUID()
  return async (stage, work) => {
    const start = performance.now()
    let ok = false
    try { const result = await work(); ok = true; return result }
    finally {
      if (process.env.XAGENT_MODEL_TIMING === '1') console.error('[xagent:model-timing]', JSON.stringify({ trace, stage, elapsedMs: Math.round(performance.now() - start), ok }))
    }
  }
}

/** Model selection must use the same complete catalog as discovery. */
async function modelCatalog(client: CodexAppServerLike, measure: Measure): Promise<{ data: unknown[] }> {
  const data: unknown[] = [], seen = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < 100; page++) {
    const response = record(await measure('model-list-page', () => client.call('model/list', cursor ? { cursor } : {})))
    if (!Array.isArray(response.data)) throw new Error('CODEX_MODEL_CATALOG_INVALID')
    data.push(...response.data)
    const next = response.nextCursor
    if (next === undefined || next === null || next === '') return { data }
    if (typeof next !== 'string' || seen.has(next)) throw new Error('CODEX_MODEL_CURSOR_INVALID')
    seen.add(next); cursor = next
  }
  throw new Error('CODEX_MODEL_CATALOG_TOO_LARGE')
}

export class ManagedCodexAdapter implements ManagedAgentAdapter {
  constructor(private readonly createClient?: () => CodexAppServerLike, private readonly launches: ManagedLaunchRegistry = defaultManagedLaunchRegistry) {}

  async open(input: ManagedAgentOpen, emit: ManagedAgentEmit): Promise<ManagedAgentConnection> {
    const launch = this.createClient ? undefined : this.launches.resolve({ sessionId: input.sessionId, agent: input.agent, workspacePath: input.workspacePath, selection: input.launch, previousFingerprint: input.launchFingerprint })
    const client = this.createClient?.() ?? new CodexAppServerClient('codex', undefined, executable => launch!.spawn(executable, ['app-server']))
    const measure = timings()
    // Connection-local: never share models across workspaces, profiles or users.
    let catalog: { value: { data: unknown[] }; expiresAt: number } | undefined
    let catalogFlight: Promise<{ data: unknown[] }> | undefined
    const models = (options?: { refresh?: boolean }): Promise<{ data: unknown[] }> => {
      if (ended) return Promise.reject(new Error('Codex process is unavailable.'))
      if (catalogFlight) return catalogFlight
      if (!options?.refresh && catalog && performance.now() < catalog.expiresAt) return Promise.resolve(catalog.value)
      const flight = modelCatalog(client, measure).then(value => {
        if (!ended) catalog = { value, expiresAt: performance.now() + 30_000 }
        return value
      }).finally(() => { if (catalogFlight === flight) catalogFlight = undefined })
      catalogFlight = flight
      return flight
    }
    let backgroundUncertain = false
    let threadId = input.providerSessionId
    let turnId: string | undefined
    let sending = false
    let active = false
    let ended = false
    const questions = new Map<string, { id: string | number; questions: ManagedQuestion[] }>()
    const approvals = new Map<string, string | number>()
    const reasoning = new Map<string, string>()
    const pendingText = new Map<string, string>()
    const unsubscribe = client.onInbound(message => {
      const p = record(message.params)
      if (typeof p.threadId === 'string' && p.threadId !== threadId) {
        if (message.kind === 'request') void client.respondError(message.id, -32602, 'Foreign thread.').catch(() => undefined)
        return
      }
      if (message.kind === 'request') {
        if (message.method === 'item/tool/requestUserInput' && threadId && p.threadId === threadId) {
          const parsed = questionsSchema.safeParse(p.questions)
          if (!parsed.success) { void client.respondError(message.id, -32602, 'Invalid questions.').catch(() => undefined); return }
          const requestId = randomUUID(); questions.set(requestId, { id: message.id, questions: parsed.data })
          emit({ type: 'question', requestId, title: 'Codex', questions: parsed.data }); return
        }
        if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method) || !threadId || p.threadId !== threadId) {
          void client.respondError(message.id, -32601, 'Unsupported managed agent request.').catch(() => undefined)
          return
        }
        const requestId = randomUUID()
        approvals.set(requestId, message.id)
        emit({ type: 'approval', requestId, title: message.method, choices: ['allow-once', 'reject-once', 'cancel'], data: p })
        return
      }
      const item = record(p.item)
      if (['collabAgentToolCall', 'subAgentActivity'].includes(String(item.type))) backgroundUncertain = true
      const itemId = typeof p.itemId === 'string' ? p.itemId : typeof item.id === 'string' ? item.id : undefined
      if (message.method === 'item/agentMessage/delta' && typeof p.delta === 'string') {
        if (itemId) { pendingText.set(itemId, (pendingText.get(itemId) ?? '') + p.delta); emit({ type: 'text-delta', itemId, text: p.delta }) }
      } else if (message.method === 'item/reasoning/summaryTextDelta' && typeof p.delta === 'string') {
        if (itemId) { reasoning.set(itemId, (reasoning.get(itemId) ?? '') + p.delta); emit({ type: 'reasoning-delta', itemId, text: p.delta }) }
      } else if (message.method === 'item/completed' && item.type === 'agentMessage') {
        const text = typeof item.text === 'string' ? item.text : itemId ? pendingText.get(itemId) : undefined
        if (text) emit({ type: 'text', text, ...(itemId ? { itemId } : {}) })
        if (itemId) pendingText.delete(itemId)
      } else if (message.method === 'item/completed' && item.type === 'reasoning' && itemId) {
        const text = reasoning.get(itemId)
        if (text) emit({ type: 'reasoning', text, itemId })
        reasoning.delete(itemId)
      } else if (['item/started', 'item/completed'].includes(message.method) && itemId && ['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch'].includes(String(item.type))) {
        emit({ type: 'tool', itemId, name: String(item.type), status: message.method === 'item/started' ? 'running' : 'completed', data: item })
      } else if (message.method === 'turn/started') {
        const id = record(p.turn).id
        if (typeof id === 'string') { turnId = id; emit({ type: 'turn-started', turnId: id }) }
      } else if (message.method === 'turn/completed') {
        const turn = record(p.turn)
        emit({ type: 'turn-completed', ...(typeof turn.id === 'string' ? { turnId: turn.id } : {}), status: turn.status === 'failed' ? 'failed' : turn.status === 'interrupted' ? 'cancelled' : 'completed' })
        turnId = undefined
        active = false
        approvals.clear(); for (const requestId of questions.keys()) emit({ type: 'question-closed', requestId }); questions.clear()
      } else if (message.method === 'error') emit({ type: 'error', code: 'CODEX_TURN_ERROR', message: 'Codex reported an execution error.' })
    })
    const unavailable = client.onUnavailable(code => { ended = true; emit({ type: 'unavailable', code }) })
    try {
      await measure('startup-initialize', () => client.start())
      const starting = measure(input.providerSessionId ? 'thread-resume' : 'thread-start', () => client.call(input.providerSessionId ? 'thread/resume' : 'thread/start', {
        ...(input.providerSessionId ? { threadId: input.providerSessionId } : {}),
        cwd: input.workspacePath, approvalPolicy: 'on-request', sandbox: 'workspace-write',
        ...(input.model ? { model: input.model } : {}),
      }))
      // Listing is independent of thread creation. Overlap the two RPCs, but
      // retain the identity fence before exposing a usable connection. Failure
      // to prefetch must not turn a successful thread startup into a failure.
      void models().catch(() => undefined)
      const response = record(await starting)
      const id = record(response.thread).id
      if (typeof id !== 'string' || !id || (input.providerSessionId && id !== input.providerSessionId)) throw new Error('Codex returned an invalid session identity.')
      threadId = id
      let defaultModel = typeof response.model === 'string' && response.model
        ? { model: response.model, ...(typeof response.reasoningEffort === 'string' ? { reasoningEffort: response.reasoningEffort } : {}) }
        : undefined
      return {
        providerSessionId: id,
        get defaultModel() { return defaultModel },
        isIdle: async () => {
          if (ended) return 'unknown'
          if (active || sending || approvals.size || questions.size || backgroundUncertain) return 'busy'
          // Capability absence is not proof of idleness; never guess from UI state.
          try {
            const response = record(await client.call('thread/read', { threadId, includeTurns: false }, 2000))
            const status = record(record(response.thread).status)
            return status.type === 'idle' ? 'idle' : status.type === 'active' ? 'busy' : 'unknown'
          } catch { return 'unknown' }
        },
        send: async ({ text }) => {
          if (ended) throw new Error('Codex process is unavailable.')
          if (sending || active) throw new Error('A turn is already running.')
          sending = true
          active = true
          try {
            const result = record(await client.call('turn/start', { threadId, input: [{ type: 'text', text }], ...(input.model ? { model: input.model } : {}), ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}) }))
            const next = record(result.turn).id
            if (typeof next !== 'string') return { state: 'unknown', reason: 'Codex did not return a turn identity.' }
            // Notifications may complete the turn before the RPC response arrives.
            if (active) turnId = next
            return { state: 'accepted', providerTurnId: next }
          } catch { return { state: 'unknown', reason: 'Codex submission acknowledgement was not received; do not automatically resend.' } }
          finally { sending = false }
        },
        answerQuestion: async (requestId, values) => {
          const question = questions.get(requestId); if (!question) throw new Error('MANAGED_QUESTION_EXPIRED')
          const answers = validateAnswers(question.questions, values)
          questions.delete(requestId)
          await client.respond(question.id, { answers: Object.fromEntries(Object.entries(answers).map(([id, answers]) => [id, { answers }])) })
          emit({ type: 'question-closed', requestId })
        },
        cancel: async () => { if (turnId) await client.call('turn/interrupt', { threadId, turnId }) },
        approve: async (requestId, choice) => {
          if (!['allow-once', 'reject-once', 'cancel'].includes(choice)) throw new Error('Invalid approval choice.')
          const request = approvals.get(requestId)
          if (request === undefined) throw new Error('Approval is no longer pending.')
          approvals.delete(requestId)
          await client.respond(request, { decision: choice === 'allow-once' ? 'accept' : choice === 'cancel' ? 'cancel' : 'decline' })
        },
        models,
        setOption: async (key, value) => {
          if (active || sending) throw new Error('Stop the turn before changing options.')
          if (key === 'model') input.model = value
          else if (key === 'reasoningEffort') input.reasoningEffort = value
          else throw new Error('Unsupported option.')
          if (key === 'model') defaultModel = { model: value, ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}) }
          else if (defaultModel) defaultModel = { ...defaultModel, reasoningEffort: value }
        },
        close: async () => { ended = true; unsubscribe(); unavailable(); approvals.clear(); questions.clear(); await client.close(); await launch?.awaitExitProof() },
      }
    } catch (error) { unsubscribe(); unavailable(); await client.close(); await launch?.awaitExitProof(); throw Object.assign(error instanceof Error ? error : new Error('Codex startup failed.'), { cleanupConfirmed: true }) }
  }
}
