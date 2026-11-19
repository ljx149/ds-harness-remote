// Orca SDK lifecycle adaptation; Copyright (c) 2026 Lovecast Inc. MIT; see ORCA-LICENSE.
import { randomUUID } from 'node:crypto'
import type { Options, PermissionMode, PermissionResult, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { createClaudeUserMessageQueue, claudeUserMessageWasProvablyUnwritten } from './claude-message-queue.js'
import { createClaudeControlSurface, runClaudeControl, ClaudeControlRequestTimeoutError, isClaudeQueryClosed } from './claude-controls.js'
import { createScopedClaudeHistory } from './claude-history.js'
import { defaultManagedLaunchRegistry, type ManagedLaunchRegistry } from './launch.js'
import { ClaudeManagedProjection, claudeRecord as record } from './claude-projection.js'
import type { ManagedManagementOperation, ManagedPromptImage } from './management.js'
import type { ManagedAgentAdapter, ManagedAgentConnection, ManagedAgentDispatch, ManagedAgentEmit, ManagedAgentOpen } from './types.js'

export type ClaudeQueryFactory = (input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query
export interface ClaudeHistoryAccess {
  messages(sessionId: string, workspacePath: string): Promise<{ uuid: string; session_id: string; parent_tool_use_id: string | null; type?: string; message?: unknown }[]>
  fork(sessionId: string, workspacePath: string, checkpointId?: string, title?: string): Promise<string>
}
const nativeHistory: ClaudeHistoryAccess = {
  messages: async (sessionId, dir) => (await import('@anthropic-ai/claude-agent-sdk')).getSessionMessages(sessionId, { dir, limit: 10_000 }),
  fork: async (sessionId, dir, checkpointId, title) => (await (await import('@anthropic-ai/claude-agent-sdk')).forkSession(sessionId, { dir, ...(checkpointId ? { upToMessageId: checkpointId } : {}), ...(title ? { title } : {}) })).sessionId,
}
const textField = (value: unknown, name: string, max = 4096): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${name}.`)
  return value
}
const imagesContent = (text: string, images?: ManagedPromptImage[]): SDKUserMessage['message']['content'] => {
  if (!images?.length) return text
  if (images.length > 8 || images.reduce((size, image) => size + image.data.length, 0) > 16_000_000) throw new Error('Images exceed the prompt bound.')
  return [
    { type: 'text', text },
    ...images.map(image => {
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mimeType) || !image.data.length || image.data.length > 5_600_000 || image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) throw new Error('Invalid image.')
      return { type: 'image' as const, source: { type: 'base64' as const, media_type: image.mimeType, data: image.data } }
    }),
  ]
}

/** Native installed Claude Code; no Orca process and no ACP bridge executable. */
export class ManagedClaudeAdapter implements ManagedAgentAdapter {
  constructor(private readonly queryFactory?: ClaudeQueryFactory, private readonly executable = 'claude', private readonly historyAccess?: ClaudeHistoryAccess, private readonly launchRegistry: ManagedLaunchRegistry = defaultManagedLaunchRegistry) {}

  async open(input: ManagedAgentOpen, emit: ManagedAgentEmit): Promise<ManagedAgentConnection> {
    const launch = this.launchRegistry.resolve({ sessionId: input.sessionId, agent: 'claude', workspacePath: input.workspacePath, selection: input.launch, previous: input.previousLaunch, previousFingerprint: input.launchFingerprint, resuming: !!input.providerSessionId })
    const query = this.queryFactory ?? (await import('@anthropic-ai/claude-agent-sdk')).query
    const sessionId = input.providerSessionId ?? randomUUID()
    const history = this.historyAccess ?? (this.queryFactory || launch.kind !== 'native' ? undefined : launch.selection.profileId === 'host' ? nativeHistory : createScopedClaudeHistory(launch))
    const inbox = createClaudeUserMessageQueue()
    const projection = new ClaudeManagedProjection(emit)
    let closed = false
    let busy = false
    let compactCommand = false
    let cancelRequested = false
    let turnId: string | undefined
    let managementInFlight = false
    let managementUncertain = false
    let defaultModel: { model: string; reasoningEffort?: string } | undefined
    const abort = new AbortController()
    const approvals = new Map<string, (choice: string) => void>()
    const questions = new Map<string, { input: Record<string, unknown>; answer: (answers: Record<string, string | string[]>) => void; cancel: () => void }>()
    const session = query({ prompt: inbox.messages, options: {
      ...launch.claudeOptions(),
      pathToClaudeCodeExecutable: launch.executable(this.executable),
      ...(input.providerSessionId ? { resume: sessionId } : { sessionId }),
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoningEffort && ['low', 'medium', 'high', 'xhigh', 'max'].includes(input.reasoningEffort) ? { effort: input.reasoningEffort as Options['effort'] } : {}),
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      permissionMode: 'default', includePartialMessages: true,
      abortController: abort,
      canUseTool: async (name, toolInput, options) => {
        if (closed || options.signal.aborted) return { behavior: 'deny', message: 'Session closed.', interrupt: true }
        return new Promise<PermissionResult>(resolve => {
          const requestId = randomUUID()
          if (name === 'AskUserQuestion' && Array.isArray(toolInput.questions)) {
            const finish = (answers?: Record<string, string | string[]>) => {
              if (!questions.delete(requestId)) return
              options.signal.removeEventListener('abort', cancelled)
              resolve(answers ? { behavior: 'allow', updatedInput: { ...toolInput, answers } } : { behavior: 'deny', message: 'Question cancelled.', interrupt: true })
            }
            const cancelled = () => finish()
            questions.set(requestId, { input: toolInput, answer: answers => finish(answers), cancel: cancelled })
            options.signal.addEventListener('abort', cancelled, { once: true })
            if (options.signal.aborted) cancelled()
            else emit({ type: 'question', requestId, title: 'Claude Code', questions: toolInput.questions.map((question, index) => ({ ...record(question), id: `q${index + 1}` })) })
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
    const has = (name: string) => typeof (session as unknown as Record<string, unknown>)[name] === 'function'
    const settlePrompts = () => {
      for (const finish of [...approvals.values()]) finish('cancel')
      for (const pending of [...questions.values()]) pending.cancel()
    }
    const consume = async () => {
      try {
        for await (const message of session) {
          if (closed) break
          const frame = record(message)
          if (message.type === 'system' && message.subtype === 'init' && typeof message.model === 'string' && message.model) defaultModel = { model: message.model }
          projection.observe(message, compactCommand)
          if (frame.type === 'system' && frame.subtype === 'session_state_changed' && frame.state === 'idle' && busy) {
            emit({ type: 'turn-completed', ...(turnId ? { turnId } : {}), status: cancelRequested ? 'cancelled' : 'completed' })
            busy = false; compactCommand = false; turnId = undefined
          }
          if (message.type === 'result' && frame.parent_tool_use_id == null) {
            if (busy && !compactCommand && frame.is_error !== true && projection.completedCheckpoint) emit({ type: 'checkpoint', checkpointId: projection.completedCheckpoint, position: 'after' })
            if (busy || turnId) emit({ type: 'turn-completed', ...(turnId ? { turnId } : {}), status: cancelRequested ? 'cancelled' : frame.is_error === true ? 'failed' : 'completed' })
            busy = false; compactCommand = false; turnId = undefined
          }
        }
      } catch {
        if (!closed) emit({ type: 'error', code: 'CLAUDE_PROCESS_FAILED', message: 'Claude Code stopped unexpectedly.' })
      } finally {
        inbox.fail(new Error('Claude Code input closed.'))
        settlePrompts()
        if (!closed) { closed = true; emit({ type: 'unavailable', code: 'CLAUDE_PROCESS_EXITED' }) }
      }
    }
    const reader = consume()
    const close = async () => {
      closed = true
      inbox.fail(new Error('Claude Code session closed.')); inbox.end(); settlePrompts()
      try { session.close() } finally { abort.abort() }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([Promise.all([reader, launch.awaitExitProof(5000)]), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Claude reader or process exit is unproven.')), 5000)
          timer.unref?.()
        })])
      } finally { clearTimeout(timer) }
    }
    const requireOpen = () => { if (closed) throw new Error('Claude Code is unavailable.') }
    const requireIdle = () => {
      requireOpen()
      if (busy || projection.providerState === 'running' || projection.providerState === 'requires_action' || projection.compacting || projection.hasActiveTasks || questions.size || approvals.size || managementInFlight || managementUncertain) throw new Error('Claude session is not confirmed idle.')
    }
    const dispatch = async (message: { messageId: string; text: string; images?: ManagedPromptImage[] }, steering = false, command = false): Promise<ManagedAgentDispatch> => {
      requireOpen()
      if (managementInFlight || managementUncertain || compactCommand || projection.compacting) throw new Error('Claude management is pending.')
      if (busy && !steering) throw new Error('A turn is already running.')
      if (!busy && steering) throw new Error('No running turn to steer.')
      const content = imagesContent(message.text, message.images)
      const uuid = randomUUID()
      if (!steering) { projection.beginTurn(); busy = true; cancelRequested = false; compactCommand = command; turnId = message.messageId; emit({ type: 'turn-started', turnId }) }
      try {
        await inbox.push({ type: 'user', uuid, ...(steering ? { priority: 'now' as const } : {}), session_id: sessionId, message: { role: 'user', content }, parent_tool_use_id: null })
        return { state: 'accepted', providerTurnId: message.messageId }
      } catch (error) {
        if (claudeUserMessageWasProvablyUnwritten(error)) { if (!steering) { busy = false; compactCommand = false; turnId = undefined }; return { state: 'rejected', reason: 'Claude message was not delivered.' } }
        return { state: 'unknown', reason: 'Claude message write outcome is unknown; do not automatically resend.' }
      }
    }
    try {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([controls.initializationResult(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Claude Code initialization timed out.')), 30_000); timer.unref?.()
        })])
      } finally { if (timer) clearTimeout(timer) }
      requireOpen()
      let settingsReaderAvailable = true
      let contextReaderAvailable = true
      const settings = record(await controls.getSettings({ timeoutMs: 5_000 }).catch(() => { settingsReaderAvailable = false; return undefined }))
      const applied = record(settings.applied)
      if (typeof applied.model === 'string' && applied.model) defaultModel = { model: applied.model, ...(typeof applied.effort === 'string' && applied.effort ? { reasoningEffort: applied.effort } : {}) }
      const tasks = () => [...projection.tasks.values()].map(task => ({ ...task, id: task.task_id, title: task.description ?? task.task_id, ...(typeof task.tool_use_id === 'string' ? { toolUseId: task.tool_use_id } : {}) }))
      const operations: ManagedManagementOperation[] = ['state', 'question.answer', 'tasks.list']
      if (has('setModel') || has('applyFlagSettings') || has('setPermissionMode')) operations.push('option.set')
      const advertised: [string, ManagedManagementOperation][] = [
        ['getContextUsage', 'context'], ['supportedCommands', 'commands'], ['getSettings', 'settings'], ['renameSession', 'rename'],
        ['mcpServerStatus', 'mcp.list'], ['reconnectMcpServer', 'mcp.reconnect'], ['toggleMcpServer', 'mcp.toggle'],
        ['mcpAuthenticate', 'mcp.authenticate'], ['mcpSubmitOAuthCallbackUrl', 'mcp.callback'], ['stopTask', 'tasks.stop'], ['backgroundTasks', 'tasks.background'],
      ]
      for (const [method, operation] of advertised) if (has(method)) operations.push(operation)
      if (has('supportedCommands')) {
        const commands = await runClaudeControl('supported_commands', () => session.supportedCommands(), 5_000).catch(() => [])
        if (commands.some(command => command.name === 'compact')) operations.push('compact')
      }
      if (history) operations.push('fork', 'rewind')
      const connection: ManagedAgentConnection = {
        providerSessionId: sessionId,
        get defaultModel() { return defaultModel },
        get managementOperations() { return [...operations, ...(projection.accountUsage === undefined ? [] : ['accountUsage' as const])] },
        isIdle: async () => closed || managementUncertain ? 'unknown' : busy || managementInFlight || projection.providerState === 'running' || projection.providerState === 'requires_action' || projection.compacting || projection.hasActiveTasks || approvals.size || questions.size ? 'busy' : 'idle',
        send: message => dispatch(message),
        steer: message => dispatch(message, true),
        cancel: async () => { requireOpen(); cancelRequested = true; await controls.interrupt({ cancelQueued: true }) },
        approve: async (requestId, choice) => {
          if (!['allow-once', 'reject-once', 'cancel'].includes(choice)) throw new Error('Invalid approval choice.')
          const finish = approvals.get(requestId)
          if (!finish) throw new Error('Approval is no longer pending.')
          finish(choice)
        },
        models: () => controls.supportedModels(),
        setOption: async (key, value) => {
          requireIdle()
          managementInFlight = true
          try {
            if (key === 'model') { await controls.setModel(value); defaultModel = { model: value } }
            else if (key === 'reasoningEffort' || key === 'effort') {
              const model = (await controls.supportedModels()).map(record).find(model => model.value === defaultModel?.model)
              if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(value) || !Array.isArray(model?.supportedEffortLevels) || !model.supportedEffortLevels.includes(value)) throw new Error('Unsupported Claude effort for the current model.')
              await controls.applyFlagSettings({ effortLevel: value as Options['effort'] })
              if (defaultModel) defaultModel = { ...defaultModel, reasoningEffort: value }
            } else if (key === 'permissionMode') {
              if (!['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions', 'auto'].includes(value)) throw new Error('Unsupported permission mode.')
              await controls.setPermissionMode(value as PermissionMode)
            } else if (key === 'fastMode') {
              if (value !== 'true' && value !== 'false') throw new Error('Invalid fast mode.')
              const model = (await controls.supportedModels()).map(record).find(model => model.value === defaultModel?.model)
              if (model?.supportsFastMode !== true) throw new Error('Fast mode is unavailable for the current model.')
              await controls.applyFlagSettings({ fastMode: value === 'true' })
            } else throw new Error('Unsupported Claude option.')
            emit({ type: 'options', data: { key, value } })
          } catch (error) {
            if (error instanceof ClaudeControlRequestTimeoutError || isClaudeQueryClosed(error)) managementUncertain = true
            throw error
          } finally { managementInFlight = false }
        },
        manage: async (operation, request) => {
          requireOpen()
          if (!connection.managementOperations?.includes(operation)) throw new Error('Unsupported Claude management operation.')
          switch (operation) {
            case 'state': return {
              idle: await connection.isIdle!(), providerSessionId: sessionId,
              checkpoints: [...projection.checkpoints].map(id => ({ id, title: id })), tasks: { tasks: tasks() }, compactInstructions: operations.includes('compact'),
              questions: [...questions].map(([requestId, pending]) => ({ requestId, title: 'Claude Code', questions: (pending.input.questions as unknown[]).map((question, index) => ({ ...record(question), id: `q${index + 1}` })) })),
            }
            case 'context': {
              // SDK method presence alone does not prove the installed CLI
              // implements this newer control request. Never stall the panel
              // or fabricate context usage from cumulative billing counters.
              if (!contextReaderAvailable) return { available: false, message: 'This Claude Code version does not report context usage.' }
              const response = await controls.getContextUsage({ timeoutMs: 3000 }).catch(() => { contextReaderAvailable = false; return undefined })
              if (response === undefined) return { available: false, message: 'Context usage is unavailable from the installed Claude Code.' }
              const raw = record(response)
              const usedTokens = typeof raw.totalTokens === 'number' && Number.isFinite(raw.totalTokens) && raw.totalTokens >= 0 ? raw.totalTokens : undefined
              const contextWindow = typeof raw.rawMaxTokens === 'number' && Number.isFinite(raw.rawMaxTokens) && raw.rawMaxTokens > 0 ? raw.rawMaxTokens : typeof raw.maxTokens === 'number' && Number.isFinite(raw.maxTokens) && raw.maxTokens > 0 ? raw.maxTokens : undefined
              const usage = { ...(usedTokens === undefined ? {} : { usedTokens }), ...(contextWindow === undefined ? {} : { contextWindow }), ...(usedTokens === undefined || contextWindow === undefined ? {} : { remainingTokens: Math.max(0, contextWindow - usedTokens), percent: usedTokens / contextWindow * 100 }) }
              emit({ type: 'context-usage', data: usage }); return usage
            }
            case 'accountUsage': return projection.accountUsage
            case 'commands': return { commands: await runClaudeControl('supported_commands', () => session.supportedCommands()) }
            case 'settings': {
              const response = settingsReaderAvailable ? await controls.getSettings({ timeoutMs: 3000 }).catch(() => { settingsReaderAvailable = false; return undefined }) : undefined
              const applied = record(record(response).applied)
              const options: { key: string; label: string; value?: unknown; choices?: unknown[] }[] = []
              if (has('setModel')) options.push({ key: 'model', label: 'Model', value: applied.model ?? defaultModel?.model, choices: (await controls.supportedModels()).map(value => { const model = record(value); return { value: model.value, label: model.displayName ?? model.value } }) })
              if (has('applyFlagSettings')) {
                options.push({ key: 'reasoningEffort', label: 'Reasoning effort', value: applied.effort ?? defaultModel?.reasoningEffort, choices: (await controls.supportedModels()).flatMap(value => { const model = record(value); return model.value === (applied.model ?? defaultModel?.model) && Array.isArray(model.supportedEffortLevels) ? model.supportedEffortLevels.filter((level): level is string => typeof level === 'string').map(value => ({ value, label: value })) : [] }) })
                if ((await controls.supportedModels()).map(record).some(model => model.value === (applied.model ?? defaultModel?.model) && model.supportsFastMode === true)) options.push({ key: 'fastMode', label: 'Fast mode', value: applied.fastMode, choices: ['true', 'false'].map(value => ({ value, label: value })) })
              }
              if (has('setPermissionMode')) options.push({ key: 'permissionMode', label: 'Permissions', value: applied.permissionMode, choices: ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'].map(value => ({ value, label: value })) })
              return { options }
            }
            case 'option.set': return connection.setOption!(textField(request.key, 'option key'), textField(request.value, 'option value'))
            case 'rename': return controls.renameSession(textField(request.title, 'title', 256), sessionId)
            case 'mcp.list': return { servers: await controls.mcp!.status() }
            case 'mcp.reconnect': return controls.mcp!.reconnect(textField(request.name, 'server name'))
            case 'mcp.toggle': {
              if (typeof request.enabled !== 'boolean') throw new Error('Invalid enabled flag.')
              return controls.mcp!.toggle(textField(request.name, 'server name'), request.enabled)
            }
            case 'mcp.authenticate': return controls.mcp!.authenticate(textField(request.name, 'server name'))
            case 'mcp.callback': return controls.mcp!.submitOAuthCallbackUrl(textField(request.name, 'server name'), textField(request.callbackUrl, 'callback URL', 8192))
            case 'tasks.list': return { tasks: tasks() }
            case 'tasks.stop': {
              const id = textField(request.taskId, 'task ID')
              if (!projection.tasks.has(id)) throw new Error('Task does not belong to this session.')
              await controls.stopTask(id)
              return { requested: true, taskId: id, confirmed: false } // CLI ACK alone is not proof of completion.
            }
            case 'tasks.background': {
              const id = textField(request.toolUseId, 'tool use ID')
              if (!projection.tools.has(id)) throw new Error('Tool is not running in this session.')
              return { requested: await controls.backgroundTask(id), toolUseId: id }
            }
            case 'question.answer': {
              const pending = questions.get(textField(request.requestId, 'request ID'))
              if (!pending) throw new Error('Question is no longer pending.')
              if (request.cancel === true) { pending.cancel(); return { answered: false } }
              const answers = record(request.answers)
              const rows = pending.input.questions as unknown[]
              const expected = rows.map((_, index) => `q${index + 1}`)
              if (Object.keys(answers).length !== expected.length || expected.some(key => !(key in answers))) throw new Error('Answers do not match the pending questions.')
              const mapped: Record<string, string | string[]> = {}
              rows.forEach((value, index) => {
                const question = record(value)
                const answer = answers[`q${index + 1}`]
                if (!Array.isArray(answer) || !answer.length || answer.length > 64 || !answer.every(item => typeof item === 'string' && item.length > 0 && item.length <= 16_384)) throw new Error('Invalid question answer.')
                if (question.multiSelect !== true && answer.length !== 1) throw new Error('Single-select question needs one answer.')
                mapped[textField(question.question, 'question')] = question.multiSelect === true ? answer as string[] : answer[0] as string
              })
              pending.answer(mapped); return { answered: true }
            }
            case 'compact': {
              requireIdle()
              const instructions = request.instructions === undefined ? '' : textField(request.instructions, 'compact instructions', 8192)
              const result = await dispatch({ messageId: randomUUID(), text: `/compact${instructions ? ` ${instructions}` : ''}` }, false, true)
              return result // boundary/result, not queue acceptance, proves completion.
            }
            case 'rewind':
            case 'fork': {
              requireIdle()
              managementInFlight = true
              try {
                const checkpointId = request.checkpointId === undefined && operation === 'fork' ? undefined : textField(request.checkpointId, 'checkpoint ID')
                if (checkpointId && !projection.checkpoints.has(checkpointId)) {
                  const messages = await history!.messages(sessionId, input.workspacePath)
                  for (const message of messages) if (message.session_id === sessionId && message.parent_tool_use_id == null && message.type === 'assistant' && ['end_turn', 'stop_sequence'].includes(String(record(message.message).stop_reason))) projection.checkpoints.add(message.uuid)
                  if (!projection.checkpoints.has(checkpointId)) throw new Error('Checkpoint does not belong to this managed conversation.')
                }
                const title = request.title === undefined ? undefined : textField(request.title, 'title', 256)
                requireOpen()
                if (busy || projection.hasActiveTasks) throw new Error('Claude session changed during checkpoint validation.')
                let providerSessionId: string
                try { providerSessionId = await history!.fork(sessionId, input.workspacePath, checkpointId, title) }
                catch (error) { managementUncertain = true; throw error }
                if (operation === 'rewind') managementUncertain = true // old head cannot accept input before backend replaces it
                return { providerSessionId, ...(checkpointId ? { checkpointId } : {}), ...(operation === 'rewind' ? { replacesProviderSessionId: sessionId } : {}) }
              } finally { managementInFlight = false }
            }
            default: throw new Error('Unsupported Claude management operation.')
          }
        },
        close,
      }
      return connection
    } catch (error) { await close(); throw error }
  }
}
