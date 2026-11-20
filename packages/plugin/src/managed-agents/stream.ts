import { randomUUID } from 'node:crypto'

type Block = { itemId: string; kind: 'text' | 'reasoning'; text: string; index: number; ended: boolean }
/** One host-owned accumulator; every viewer receives the same revision and
 * reconnect baseline. Final provider frames replace deltas, never append twice. */
export class ManagedAssistantStream {
  private revision = 0
  private active?: { attemptId: string; startedAfterSeq: number; turn: number; step: number; nextIndex: number; stream: unknown[] }
  private blocks: Block[] = []
  private committed = new Set<string>()
  constructor(private readonly publish: (frame: unknown) => void) {}
  snapshot() { return structuredClone({ revision: this.revision, ...(this.active ? { activeAttempt: this.active } : {}) }) }
  private chunk(chunk: unknown) {
    const active = this.active!
    const time = Date.now(), index = active.nextIndex++
    active.stream.push({ type: 'chunk', time, chunk })
    this.publish({ type: 'chunk', attemptId: active.attemptId, revision: ++this.revision, index, time, chunk })
  }
  accept(itemId: string, kind: Block['kind'], text: string, final: boolean, cursor: number, turn: number, step = 1) {
    if (this.committed.has(itemId)) return
    if (!this.active) {
      this.active = { attemptId: randomUUID(), startedAfterSeq: cursor, turn, step, nextIndex: 0, stream: [] }
      this.publish({ type: 'start', attemptId: this.active.attemptId, startedAfterSeq: cursor, turn, step, revision: ++this.revision })
    }
    let block = this.blocks.find(block => block.itemId === itemId)
    if (!block) {
      block = { itemId, kind, text: '', index: this.blocks.length, ended: false }
      this.blocks.push(block)
      this.chunk({ type: 'block-start', index: block.index, blockType: kind })
    }
    if (block.ended) return
    if (final) {
      block.text = text
      block.ended = true
      this.chunk({ type: 'block-end', index: block.index, block: { type: kind, text } })
    } else {
      block.text += text
      this.chunk({ type: kind === 'text' ? 'text-delta' : 'reasoning-delta', index: block.index, text })
    }
  }
  flush(commit: (content: Array<{ type: string; text: string }>) => number) {
    const active = this.active
    if (!active) return false
    for (const block of this.blocks) if (!block.ended) this.chunk({ type: 'block-end', index: block.index, block: { type: block.kind, text: block.text } })
    this.chunk({ type: 'finish', reason: { kind: 'stop' } })
    // Finish transient output before advancing the durable cursor. Otherwise
    // DSH assigns this chunk a sequence after the held settlement, then tries
    // to append the older settlement to the same conversation context.
    const seq = commit(this.blocks.map(block => ({ type: block.kind, text: block.text })))
    this.publish({ type: 'end', attemptId: active.attemptId, revision: ++this.revision, index: active.nextIndex, outcome: { kind: 'committed', eventType: 'assistant/message', seq } })
    for (const block of this.blocks) this.committed.add(block.itemId)
    this.active = undefined; this.blocks = []
    return true
  }
}
