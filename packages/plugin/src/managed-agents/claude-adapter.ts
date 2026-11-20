import { defaultManagedLaunchRegistry, type ManagedLaunchRegistry } from './launch.js'
import { questionsSchema, validateAnswers, type ManagedQuestion } from './questions.js'
import { ClaudeChatProjection } from './claude-projection.js'
// Orca SDK lifecycle adaptation; Copyright (c) 2026 Lovecast Inc. MIT; see ORCA-LICENSE.
import { randomUUID } from 'node:crypto'
import type { Options, PermissionResult, Query } from '@anthropic-ai/claude-agent-sdk'
import { createClaudeUserMessageQueue, claudeUserMessageWasProvablyUnwritten } from './claude-message-queue.js'
import { createClaudeControlSurface } from './claude-controls.js'
import type { ManagedAgentAdapter, ManagedAgentConnection, ManagedAgentEmit, ManagedAgentOpen } from './types.js'

export type ClaudeQueryFactory = (input: { prompt: AsyncIterable<import('@anthropic-ai/claude-agent-sdk').SDKUserMessage>; options: Options }) => Query
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Native installed Claude Code; no Orca process and no ACP bridge executable. */
export class ManagedClaudeAdapter implements ManagedAgentAdapter {
  constructor(private readonly queryFactory?: ClaudeQueryFactory, private readonly executable = 'claude', private readonly launches: ManagedLaunchRegistry = defaultManagedLaunchRegistry) {}

  async open(input: ManagedAgentOpen, emit: ManagedAgentEmit): Promise<ManagedAgentConnection> {
    const launch = this.launches.resolve({ sessionId: input.sessionId, agent: input.agent, workspacePath: input.workspacePath, selection: input.launch, previousFingerprint: input.launchFingerprint })
    const query = this.queryFactory ?? (await import('@anthropic-ai/claude-agent-sdk')).query
    const sessionId = input.providerSessionId ?? randomUUID()
    const inbox = createClaudeUserMessageQueue()
    const projection = new ClaudeChatProjection(emit)
    let closed = false
    let busy = false
    let turnId: string | undefined
    let defaultModel: { model: string; reasoningEffort?: string } | undefined
    const abort = new AbortController()
    const questions = new Map<string, { questions: ManagedQuestion[]; finish: (answers?: Record<string, string[]>) => void }>()
    const approvals = new Map<string, (choice: string) => void>()
    const session = query({ prompt: inbox.messages, options: {
      ...launch.claudeOptions(),
      pathToClaudeCodeExecutable: this.executable,
      ...(input.providerSessionId ? { resume: sessionId } : { sessionId }),
      ...(input.model ? { model: input.model } : {}),
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      permissionMode: 'default', includePartialMessages: true,
      abortController: abort,
      canUseTool: async (name, toolInput, options) => {
        if (closed || options.signal.aborted) return { behavior: 'deny', message: 'Session closed.', interrupt: true }
        return new Promise<PermissionResult>(resolve => {
          const requestId = randomUUID()
          if (name === 'AskUserQuestion') {
            const raw = Array.isArray(toolInput.questions) ? toolInput.questions : []
            const parsed = questionsSchema.safeParse(raw.map((item, index) => ({ ...record(item), id: `q${index}` })))
            if (!parsed.success) { resolve({ behavior: 'deny', message: 'Invalid question.', interrupt: true }); return }
            const cancelled = () => finishQuestion()
            const finishQuestion = (answers?: Record<string, string[]>) => {
              if (!questions.delete(requestId)) return
              options.signal.removeEventListener('abort', cancelled)
              resolve(answers ? { behavior: 'allow', updatedInput: { ...toolInput, answers: Object.fromEntries(parsed.data.map(question => [question.question, answers[question.id]!.join(', ')])) } } : { behavior: 'deny', message: 'Question cancelled.', interrupt: true })
              emit({ type: 'question-closed', requestId })
            }
            questions.set(requestId, { questions: parsed.data, finish: finishQuestion })
            options.signal.addEventListener('abort', cancelled, { once: true })
            if (options.signal.aborted) cancelled()
            else emit({ type: 'question', requestId, title: 'Claude Code', questions: parsed.data })
            return
          }
          const finish = (choice: string) => {
            if (!approvals.delete(requestId)) return
            options.signal.removeEventListener('abort', cancelled)
            resolve(choice === 'allow-once' ? { behavior: 'allow', updatedInput: toolInput } : { behavior: 'deny', message: 'User declined the tool request.', interrupt: choice === 'cancel' })
          }
          const cancelled = () => finish('cancel')
          approvals.set(requestId, finish)
          options.signal.addEventListener('abort', cancelled, { once: true })
          if (options.signal.aborted) cancelled()
          else emit({ type: 'approval', requestId, title: name, choices: ['allow-once', 'reject-once', 'cancel'], data: { name, input: toolInput } })
        })
      },
    } })
    const controls = createClaudeControlSurface(session)
    const consume = async () => {
      try {
        for await (const message of session) {
          if (closed) break
          if (message.type === 'system' && message.subtype === 'init' && typeof message.model === 'string' && message.model) defaultModel = { model: message.model }
          projection.observe(message)
          if (message.type === 'result' && record(message).parent_tool_use_id == null) {
            const finished = turnId
            busy = false; turnId = undefined
            for (const question of [...questions.values()]) question.finish()
            if (finished) emit({ type: 'turn-completed', turnId: finished, status: record(message).is_error === true ? 'failed' : 'completed' })
          }
        }
      } catch {
        if (!closed) emit({ type: 'error', code: 'CLAUDE_PROCESS_FAILED', message: 'Claude Code stopped unexpectedly.' })
      } finally {
        for (const question of [...questions.values()]) question.finish()
        inbox.fail(new Error('Claude Code input closed.'))
        for (const finish of [...approvals.values()]) finish('cancel')
        if (!closed) { closed = true; emit({ type: 'unavailable', code: 'CLAUDE_PROCESS_EXITED' }) }
      }
    }
    const reader = consume()
    const close = async () => {
      closed = true
      for (const question of [...questions.values()]) question.finish()
      inbox.fail(new Error('Claude Code session closed.'))
      inbox.end()
      for (const finish of [...approvals.values()]) finish('cancel')
      try { session.close() } finally { abort.abort() }
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([Promise.all([reader, launch.awaitExitProof()]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Claude cleanup unconfirmed.')), 6000) })]) }
      finally { clearTimeout(timer) }
    }
    try {
      // Bounded startup; failure closes this owned query rather than abandoning a child.
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([controls.initializationResult(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Claude Code initialization timed out.')), 30_000)
          timer.unref?.()
        })])
      } finally { if (timer) clearTimeout(timer) }
      if (closed) throw new Error('Claude Code exited during initialization.')
      // Orca observes applied CLI settings, never guesses from the first catalog item.
      const settings = record(await controls.getSettings({ timeoutMs: 5_000 }).catch(() => undefined))
      const applied = record(settings.applied)
      if (typeof applied.model === 'string' && applied.model) defaultModel = {
        model: applied.model, ...(typeof applied.effort === 'string' && applied.effort ? { reasoningEffort: applied.effort } : {}),
      }
      return {
        providerSessionId: sessionId,
        get defaultModel() { return defaultModel },
        send: async ({ messageId, text }) => {
          if (closed) throw new Error('Claude Code is unavailable.')
          if (busy) throw new Error('A turn is already running.')
          busy = true
          turnId = messageId
          emit({ type: 'turn-started', turnId: messageId })
          try {
            await inbox.push({ type: 'user', session_id: sessionId, message: { role: 'user', content: text }, parent_tool_use_id: null })
            return { state: 'accepted', providerTurnId: messageId }
          } catch (error) {
            if (claudeUserMessageWasProvablyUnwritten(error)) { busy = false; turnId = undefined; return { state: 'rejected', reason: 'Claude message was not delivered.' } }
            return { state: 'unknown', reason: 'Claude message write outcome is unknown; do not automatically resend.' }
          }
        },
        answerQuestion: async (requestId, answers) => {
          const question = questions.get(requestId); if (!question) throw new Error('MANAGED_QUESTION_EXPIRED')
          question.finish(validateAnswers(question.questions, answers))
        },
        isIdle: async () => closed ? 'unknown' : busy || approvals.size || questions.size || !projection.idleSafe ? 'busy' : 'idle',
        cancel: async () => { await controls.interrupt({ cancelQueued: true }) },
        approve: async (requestId, choice) => {
          if (!['allow-once', 'reject-once', 'cancel'].includes(choice)) throw new Error('Invalid approval choice.')
          const finish = approvals.get(requestId)
          if (!finish) throw new Error('Approval is no longer pending.')
          finish(choice)
        },
        models: () => controls.supportedModels(),
        setOption: async (key, value) => {
          if (busy) throw new Error('Stop the turn before changing options.')
          if (key !== 'model') throw new Error('Unsupported Claude option.')
          await controls.setModel(value)
          defaultModel = { model: value }
        },
        close,
      }
    } catch (error) { await close(); throw Object.assign(error instanceof Error ? error : new Error('Claude startup failed.'), { cleanupConfirmed: true }) }
  }

}
