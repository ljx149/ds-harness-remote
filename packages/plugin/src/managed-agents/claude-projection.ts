// Adapted from Orca's Claude streamed-block identity/journal. MIT; see ORCA-LICENSE.
import type { ManagedAgentEmit } from './types.js'
export const claudeRecord = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** SDK stream envelopes have different UUIDs from final assistant messages.
 * Reconcile using Anthropic message.id and block index, scoped to the producing
 * session/subagent, exactly as Orca's streamed block registry does. */
export class ClaudeManagedProjection {
  private streams = new Map<string, string>()
  readonly tasks = new Map<string, Record<string, unknown>>()
  readonly tools = new Set<string>()
  readonly checkpoints = new Set<string>()
  private activeTaskIds: Set<string> | undefined
  accountUsage: unknown
  providerState: string | undefined
  private lastRootEntry: string | undefined
  compacting = false
  constructor(private readonly emit: ManagedAgentEmit) {}
  beginTurn(): void { this.lastRootEntry = undefined }
  get completedCheckpoint(): string | undefined { return this.lastRootEntry }
  observe(value: unknown, suppressConversation = false): void {
    const frame = claudeRecord(value)
    const body = claudeRecord(frame.message)
    const scope = `${String(frame.session_id ?? '')}/${String(frame.parent_tool_use_id ?? '')}`
    const root = frame.parent_tool_use_id == null
    if (root && typeof frame.uuid === 'string' && frame.type === 'assistant') this.lastRootEntry = frame.uuid
    if (root && frame.type === 'result' && frame.is_error !== true && frame.subtype === 'success' && this.lastRootEntry) this.checkpoints.add(this.lastRootEntry)
    if (frame.type === 'stream_event') {
      const event = claudeRecord(frame.event)
      if (event.type === 'message_start') {
        const message = claudeRecord(event.message)
        if (typeof message.id === 'string') this.streams.set(scope, message.id)
      }
      const messageId = this.streams.get(scope)
      if (!messageId || suppressConversation) return
      const index = typeof event.index === 'number' ? event.index : 0
      const delta = claudeRecord(event.type === 'content_block_start' ? event.content_block : event.delta)
      const text = delta.type === 'text' || delta.type === 'text_delta' ? delta.text : delta.type === 'thinking' || delta.type === 'thinking_delta' ? delta.thinking : undefined
      if (typeof text === 'string' && text) this.emit({ type: delta.type === 'text' || delta.type === 'text_delta' ? 'text-delta' : 'reasoning-delta', itemId: `claude:${scope}:block:${messageId}:${index}`, text })
    } else if ((frame.type === 'assistant' || frame.type === 'user') && Array.isArray(body.content)) {
      const messageId = typeof body.id === 'string' ? body.id : String(frame.uuid ?? '')
      body.content.forEach((block: unknown, index: number) => {
        const item = claudeRecord(block)
        const itemId = `claude:${scope}:block:${messageId}:${index}`
        if (!suppressConversation && frame.type === 'assistant' && item.type === 'text' && typeof item.text === 'string') this.emit({ type: 'text', itemId, text: item.text })
        else if (!suppressConversation && frame.type === 'assistant' && item.type === 'thinking' && typeof item.thinking === 'string') this.emit({ type: 'reasoning', itemId, text: item.thinking })
        else if (item.type === 'tool_use' && typeof item.id === 'string') {
          this.tools.add(item.id)
          this.emit({ type: 'tool', itemId: item.id, name: String(item.name ?? 'Tool'), status: 'running', data: item })
        } else if (item.type === 'tool_result' && typeof item.tool_use_id === 'string') {
          this.tools.delete(item.tool_use_id)
          this.emit({ type: 'tool', itemId: item.tool_use_id, name: 'Tool result', status: 'completed', data: item })
        }
      })
    } else if (frame.type === 'rate_limit_event') {
      const usage = claudeRecord(frame.rate_limit_info)
      const utilization = typeof usage.utilization === 'number' && Number.isFinite(usage.utilization) ? usage.utilization : undefined
      this.accountUsage = { windows: [{ name: String(usage.rateLimitType ?? 'subscription'), ...(utilization === undefined ? {} : { usedPercent: utilization * 100 }), ...(typeof usage.resetsAt === 'number' && Number.isFinite(usage.resetsAt) && Math.abs(usage.resetsAt * 1000) <= 8.64e15 ? { resetsAt: new Date(usage.resetsAt * 1000).toISOString() } : {}) }], message: String(usage.status ?? 'unknown') }
      this.emit({ type: 'account-usage', data: this.accountUsage })
    } else if (frame.type === 'system') {
      if (frame.subtype === 'session_state_changed' && typeof frame.state === 'string') this.providerState = frame.state
      if (frame.subtype === 'status') this.compacting = frame.status === 'compacting'
      if (frame.subtype === 'compact_boundary') {
        this.compacting = false
        this.emit({ type: 'compacted', data: frame.compact_metadata ?? {} })
      }
      if (frame.subtype === 'background_tasks_changed' && Array.isArray(frame.tasks)) {
        this.activeTaskIds = new Set(frame.tasks.map(task => String(claudeRecord(task).task_id)))
        for (const task of frame.tasks) { const value = claudeRecord(task); if (typeof value.task_id === 'string') this.tasks.set(value.task_id, { ...value, status: 'running' }) }
        this.emit({ type: 'background-task', data: { type: 'snapshot', tasks: frame.tasks } })
      }
      if (typeof frame.task_id === 'string' && ['task_started', 'task_progress', 'task_updated', 'task_notification'].includes(String(frame.subtype))) {
        const task = { ...this.tasks.get(frame.task_id), ...frame }
        this.tasks.set(frame.task_id, task)
        this.emit({ type: 'background-task', data: task })
      }
    }
  }
  get hasActiveTasks(): boolean {
    if (this.activeTaskIds) return this.activeTaskIds.size > 0
    return [...this.tasks.values()].some(task => !['completed', 'failed', 'stopped', 'cancelled'].includes(String(task.status ?? 'running')))
  }
}
