import { randomUUID } from 'node:crypto'
import { ClaudeAcpClient } from '../acp/adapters/claude-process.js'
import type { CursorAcpLike } from '../acp/adapters/cursor-process.js'
import type { ManagedAgentAdapter, ManagedAgentConnection, ManagedAgentEmit, ManagedAgentOpen } from './types.js'

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Shared ACP provider lifecycle; construction decides the binary, never a remote request. */
export class ManagedAcpAdapter implements ManagedAgentAdapter {
  constructor(private readonly createClient: (input: ManagedAgentOpen) => CursorAcpLike = input => new ClaudeAcpClient('claude-agent-acp', undefined, undefined, { cwd: input.workspacePath })) {}

  async open(input: ManagedAgentOpen, emit: ManagedAgentEmit): Promise<ManagedAgentConnection> {
    const client = this.createClient(input)
    let sessionId = input.providerSessionId
    let busy = false
    let closed = false
    let loading = true
    const approvals = new Map<string, { id: string | number; choices: Map<string, string> }>()
    const unsubscribe = client.onInbound(message => {
      const p = record(message.params)
      if (typeof p.sessionId === 'string' && p.sessionId !== sessionId) return
      if (message.kind === 'request') {
        if (message.method !== 'session/request_permission' || loading || p.sessionId !== sessionId) {
          void client.respondError(message.id, -32601, 'Unsupported managed agent request.').catch(() => undefined)
          return
        }
        const choices = new Map<string, string>(Array.isArray(p.options) ? p.options.flatMap(option => {
          const row = record(option)
          return ['allow_once', 'reject_once'].includes(String(row.kind)) && typeof row.optionId === 'string' ? [[row.kind === 'allow_once' ? 'allow-once' : 'reject-once', row.optionId] as [string, string]] : []
        }) : [])
        const requestId = randomUUID()
        approvals.set(requestId, { id: message.id, choices })
        emit({ type: 'approval', requestId, title: String(record(p.toolCall).title ?? 'Tool permission'), choices: [...choices.keys(), 'cancel'], data: p })
        return
      }
      if (loading || message.method !== 'session/update') return
      const update = record(p.update)
      const content = record(update.content)
      if (update.sessionUpdate === 'agent_message_chunk' && content.type === 'text' && typeof content.text === 'string') emit({ type: 'text', text: content.text })
      else if (update.sessionUpdate === 'agent_thought_chunk' && content.type === 'text' && typeof content.text === 'string') emit({ type: 'reasoning', text: content.text })
      else if (['tool_call', 'tool_call_update'].includes(String(update.sessionUpdate)) && typeof update.toolCallId === 'string') emit({ type: 'tool', itemId: update.toolCallId, name: String(update.title ?? 'Tool'), status: ['completed', 'failed'].includes(String(update.status)) ? 'completed' : 'running', data: update })
    })
    const unavailable = client.onUnavailable(code => { closed = true; emit({ type: 'unavailable', code }) })
    try {
      await client.start()
      const response = record(await client.call(input.providerSessionId ? 'session/load' : 'session/new', {
        ...(input.providerSessionId ? { sessionId: input.providerSessionId } : {}), cwd: input.workspacePath, mcpServers: [],
      }))
      const id = response.sessionId ?? input.providerSessionId
      if (typeof id !== 'string' || !id || (input.providerSessionId && id !== input.providerSessionId)) throw new Error('ACP returned an invalid session identity.')
      sessionId = id
      loading = false
      if (input.model) await client.call('dsh/selectModel', { sessionId, model: input.model, ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}) })
      return {
        providerSessionId: id,
        send: async ({ messageId, text }) => {
          if (closed) throw new Error('Agent process is unavailable.')
          if (busy) throw new Error('A turn is already running.')
          busy = true
          emit({ type: 'turn-started', turnId: messageId })
          // ACP acknowledges only at turn completion; host keeps execution alive across follower disconnects.
          void client.call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }).then(result => {
            busy = false
            approvals.clear()
            emit({ type: 'turn-completed', turnId: messageId, status: record(result).stopReason === 'cancelled' ? 'cancelled' : 'completed' })
          }, () => {
            // Delivery is ambiguous; hold the session busy until close/recovery instead of permitting a duplicate turn.
            emit({ type: 'error', code: 'ACP_DELIVERY_UNKNOWN', message: 'Agent acknowledgement was not received; do not automatically resend.' })
          })
          return { state: 'accepted', providerTurnId: messageId }
        },
        cancel: async () => { await client.call('session/cancel', { sessionId }) },
        approve: async (requestId, choice) => {
          const approval = approvals.get(requestId)
          if (!approval || (choice !== 'cancel' && !approval.choices.has(choice))) throw new Error('Approval is missing or choice is invalid.')
          approvals.delete(requestId)
          await client.respond(approval.id, { outcome: choice === 'cancel' ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: approval.choices.get(choice) } })
        },
        models: () => client.call('dsh/sessionModels', { sessionId }),
        setOption: async (key, value) => {
          if (busy) throw new Error('Stop the turn before changing options.')
          if (key !== 'model') throw new Error('Unsupported ACP option.')
          await client.call('dsh/selectModel', { sessionId, model: value })
        },
        close: async () => { closed = true; unsubscribe(); unavailable(); approvals.clear(); await client.close() },
      }
    } catch (error) { unsubscribe(); unavailable(); await client.close(); throw error }
  }
}
