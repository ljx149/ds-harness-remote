// Stream identity adapted from Orca. MIT; see ORCA-LICENSE.
import type { ManagedAgentEmit } from './types.js'
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
/** Only root conversation blocks are presented; subagent messages remain tool output. */
export class ClaudeChatProjection {
  private messageId?: string
  readonly tools = new Set<string>()
  private readonly tasks = new Set<string>()
  private compacting = false
  constructor(private readonly emit: ManagedAgentEmit) {}
  get idleSafe(): boolean { return !this.tools.size && !this.tasks.size && !this.compacting }
  observe(value: unknown): void {
    const frame = record(value), body = record(frame.message)
    if (frame.type === 'system') {
      if (frame.subtype === 'status') this.compacting = frame.status === 'compacting'
      if (frame.subtype === 'compact_boundary') this.compacting = false
      if (frame.subtype === 'background_tasks_changed' && Array.isArray(frame.tasks)) {
        this.tasks.clear(); for (const task of frame.tasks) this.tasks.add(String(record(task).task_id))
      }
      if (typeof frame.task_id === 'string') {
        if (['completed', 'failed', 'stopped', 'cancelled'].includes(String(frame.status))) this.tasks.delete(frame.task_id)
        else this.tasks.add(frame.task_id)
      }
    }
    if (frame.parent_tool_use_id != null) return
    if (frame.type === 'stream_event') {
      const event = record(frame.event)
      if (event.type === 'message_start') { const id = record(event.message).id; this.messageId = typeof id === 'string' ? id : undefined }
      if (!this.messageId) return
      const index = typeof event.index === 'number' ? event.index : 0
      const delta = record(event.type === 'content_block_start' ? event.content_block : event.delta)
      const text = delta.type === 'text' || delta.type === 'text_delta' ? delta.text : delta.type === 'thinking' || delta.type === 'thinking_delta' ? delta.thinking : undefined
      if (typeof text === 'string' && text) this.emit({ type: delta.type === 'text' || delta.type === 'text_delta' ? 'text-delta' : 'reasoning-delta', itemId: `claude:${this.messageId}:${index}`, text })
    } else if ((frame.type === 'assistant' || frame.type === 'user') && Array.isArray(body.content)) {
      const messageId = typeof body.id === 'string' ? body.id : String(frame.uuid ?? '')
      body.content.forEach((block, index) => {
        const item = record(block), itemId = `claude:${messageId}:${index}`
        if (frame.type === 'assistant' && item.type === 'text' && typeof item.text === 'string') this.emit({ type: 'text', itemId, text: item.text })
        else if (frame.type === 'assistant' && item.type === 'thinking' && typeof item.thinking === 'string') this.emit({ type: 'reasoning', itemId, text: item.thinking })
        else if (item.type === 'tool_use' && typeof item.id === 'string') { this.tools.add(item.id); this.emit({ type: 'tool', itemId: item.id, name: String(item.name ?? 'Tool'), status: 'running', data: item }) }
        else if (item.type === 'tool_result' && typeof item.tool_use_id === 'string') { this.tools.delete(item.tool_use_id); this.emit({ type: 'tool', itemId: item.tool_use_id, name: 'Tool result', status: 'completed', data: item }) }
      })
    }
  }
}
