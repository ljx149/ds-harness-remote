import { randomUUID } from 'node:crypto'
import { CodexAppServerClient, type CodexAppServerLike } from '../codex/app-server.js'
import type { ManagedAgentAdapter, ManagedAgentConnection, ManagedAgentEmit, ManagedAgentOpen } from './types.js'

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

export class ManagedCodexAdapter implements ManagedAgentAdapter {
  constructor(private readonly createClient: () => CodexAppServerLike = () => new CodexAppServerClient('codex')) {}

  async open(input: ManagedAgentOpen, emit: ManagedAgentEmit): Promise<ManagedAgentConnection> {
    const client = this.createClient()
    let threadId = input.providerSessionId
    let turnId: string | undefined
    let sending = false
    let active = false
    let ended = false
    const approvals = new Map<string, string | number>()
    const reasoning = new Map<string, string>()
    const pendingText = new Map<string, string>()
    const unsubscribe = client.onInbound(message => {
      const p = record(message.params)
      if (typeof p.threadId === 'string' && p.threadId !== threadId) return
      if (message.kind === 'request') {
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
      const itemId = typeof p.itemId === 'string' ? p.itemId : typeof item.id === 'string' ? item.id : undefined
      if (message.method === 'item/agentMessage/delta' && typeof p.delta === 'string') {
        if (itemId) pendingText.set(itemId, (pendingText.get(itemId) ?? '') + p.delta)
      } else if (message.method === 'item/reasoning/summaryTextDelta' && typeof p.delta === 'string') {
        if (itemId) reasoning.set(itemId, (reasoning.get(itemId) ?? '') + p.delta)
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
        approvals.clear()
      } else if (message.method === 'error') emit({ type: 'error', code: 'CODEX_TURN_ERROR', message: 'Codex reported an execution error.' })
    })
    const unavailable = client.onUnavailable(code => { ended = true; emit({ type: 'unavailable', code }) })
    try {
      await client.start()
      const response = record(await client.call(input.providerSessionId ? 'thread/resume' : 'thread/start', {
        ...(input.providerSessionId ? { threadId: input.providerSessionId } : {}),
        cwd: input.workspacePath, approvalPolicy: 'on-request', sandbox: 'workspace-write',
        ...(input.model ? { model: input.model } : {}),
      }))
      const id = record(response.thread).id
      if (typeof id !== 'string' || !id || (input.providerSessionId && id !== input.providerSessionId)) throw new Error('Codex returned an invalid session identity.')
      threadId = id
      let defaultModel = typeof response.model === 'string' && response.model
        ? { model: response.model, ...(typeof response.reasoningEffort === 'string' ? { reasoningEffort: response.reasoningEffort } : {}) }
        : undefined
      return {
        providerSessionId: id,
        get defaultModel() { return defaultModel },
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
        cancel: async () => { if (turnId) await client.call('turn/interrupt', { threadId, turnId }) },
        approve: async (requestId, choice) => {
          if (!['allow-once', 'reject-once', 'cancel'].includes(choice)) throw new Error('Invalid approval choice.')
          const request = approvals.get(requestId)
          if (request === undefined) throw new Error('Approval is no longer pending.')
          approvals.delete(requestId)
          await client.respond(request, { decision: choice === 'allow-once' ? 'accept' : choice === 'cancel' ? 'cancel' : 'decline' })
        },
        models: () => client.call('model/list', {}),
        setOption: async (key, value) => {
          if (active || sending) throw new Error('Stop the turn before changing options.')
          if (key === 'model') input.model = value
          else if (key === 'reasoningEffort') input.reasoningEffort = value
          else throw new Error('Unsupported option.')
          if (key === 'model') defaultModel = { model: value, ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}) }
          else if (defaultModel) defaultModel = { ...defaultModel, reasoningEffort: value }
        },
        close: async () => { ended = true; unsubscribe(); unavailable(); approvals.clear(); await client.close() },
      }
    } catch (error) { unsubscribe(); unavailable(); await client.close(); throw error }
  }
}
