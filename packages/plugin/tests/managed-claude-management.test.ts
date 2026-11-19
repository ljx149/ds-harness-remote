import { describe, expect, it, vi } from 'vitest'
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { ManagedClaudeAdapter, type ClaudeHistoryAccess, type ClaudeQueryFactory } from '../src/managed-agents/claude-adapter.js'
import type { ManagedAgentEvent } from '../src/managed-agents/types.js'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
it('keeps management usable when the SDK exposes controls absent from the installed CLI', async () => {
  const getSettings = vi.fn(async () => { throw new Error('unsupported control') })
  const getContextUsage = vi.fn(async () => { throw new Error('unsupported control') })
  const h = await rig({ getSettings, getContextUsage })
  try {
    expect(await h.connection.manage!('context', {})).toMatchObject({ available: false })
    expect(await h.connection.manage!('context', {})).toMatchObject({ available: false })
    expect(getContextUsage).toHaveBeenCalledTimes(1)
    expect(await h.connection.manage!('settings', {})).toMatchObject({ options: [{ key: 'model', choices: [{ value: 'custom-claude' }] }, { key: 'reasoningEffort' }, { key: 'permissionMode' }] })
    expect(getSettings).toHaveBeenCalledTimes(1)
  } finally { await h.close() }
})
async function rig(extra: Record<string, unknown> = {}, history?: ClaudeHistoryAccess) {
  let options!: Options
  let done = false
  let wake: (() => void) | undefined
  let pump: Promise<void> | undefined
  const frames: SDKMessage[] = []
  const sent: SDKUserMessage[] = []
  const events: ManagedAgentEvent[] = []
  const methods = {
    initializationResult: async () => ({}),
    getSettings: async () => ({ applied: { model: 'custom-claude', effort: 'high' } }),
    supportedCommands: async () => [{ name: 'compact' }],
    supportedModels: async () => [{ value: 'custom-claude', displayName: 'Custom Claude', supportsFastMode: true, supportedEffortLevels: ['medium', 'high'] }],
    getContextUsage: async () => ({ totalTokens: 40, rawMaxTokens: 100 }),
    setModel: vi.fn(async () => {}), applyFlagSettings: vi.fn(async () => {}), setPermissionMode: vi.fn(async () => {}),
    interrupt: vi.fn(async () => ({})),
    mcpServerStatus: vi.fn(async () => [{ name: 'local', status: 'connected' }]),
    reconnectMcpServer: vi.fn(async () => {}), toggleMcpServer: vi.fn(async () => {}),
    mcpAuthenticate: vi.fn(async () => ({ authUrl: 'https://example.com/auth', callbackExpected: true })),
    mcpSubmitOAuthCallbackUrl: vi.fn(async () => {}),
    renameSession: vi.fn(async () => {}), stopTask: vi.fn(async () => {}), backgroundTasks: vi.fn(async () => true),
    ...extra,
  }
  const factory: ClaudeQueryFactory = input => {
    options = input.options
    pump = (async () => { for await (const message of input.prompt) sent.push(message) })()
    return {
      ...methods,
      close: () => { done = true; wake?.() },
      async *[Symbol.asyncIterator]() {
        while (!done) {
          if (!frames.length) await new Promise<void>(resolve => { wake = resolve })
          while (frames.length && !done) yield frames.shift()!
        }
      },
    } as unknown as Query
  }
  const connection = await new ManagedClaudeAdapter(factory, 'claude', history).open({ sessionId: 'owned', providerSessionId: 'provider-owned', workspacePath: '/owned/work', agent: 'claude' }, event => events.push(event))
  return {
    connection, options, events, sent, methods,
    publish: async (frame: Record<string, unknown>) => { frames.push(frame as unknown as SDKMessage); wake?.(); await tick() },
    close: async () => { await connection.close(); await pump },
  }
}

describe('Claude management without an Orca desktop', () => {
  it('reconciles streamed text/thinking and finals with the same block identities', async () => {
    const h = await rig()
    try {
      expect(h.options.includePartialMessages).toBe(true)
      const base = { session_id: 'provider-owned', parent_tool_use_id: null }
      await h.publish({ ...base, type: 'stream_event', uuid: 'envelope-a', event: { type: 'message_start', message: { id: 'anthropic-message' } } })
      await h.publish({ ...base, type: 'stream_event', uuid: 'envelope-b', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } } })
      await h.publish({ ...base, type: 'stream_event', uuid: 'envelope-c', event: { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'reason' } } })
      await h.publish({ ...base, type: 'assistant', uuid: 'transcript-uuid', message: { id: 'anthropic-message', content: [{ type: 'text', text: 'hello' }, { type: 'thinking', thinking: 'reason' }] } })
      expect(h.events.filter(event => ['text-delta', 'text'].includes(event.type))).toEqual([
        { type: 'text-delta', itemId: 'claude:provider-owned/:block:anthropic-message:0', text: 'hello' },
        { type: 'text', itemId: 'claude:provider-owned/:block:anthropic-message:0', text: 'hello' },
      ])
      expect(h.events.filter(event => ['reasoning-delta', 'reasoning'].includes(event.type))).toEqual([
        { type: 'reasoning-delta', itemId: 'claude:provider-owned/:block:anthropic-message:1', text: 'reason' },
        { type: 'reasoning', itemId: 'claude:provider-owned/:block:anthropic-message:1', text: 'reason' },
      ])
    } finally { await h.close() }
  })

  it('passes image blocks and explicit live steering priority through the SDK', async () => {
    const h = await rig()
    try {
      await h.connection.send({ messageId: 'first', text: 'describe', images: [{ mimeType: 'image/png', data: 'YQ==' }] })
      expect(h.sent[0]?.message.content).toEqual([{ type: 'text', text: 'describe' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } }])
      await h.connection.steer!({ messageId: 'second', text: 'focus on the border' })
      expect(h.sent[1]?.priority).toBe('now')
      expect(await h.connection.isIdle!()).toBe('busy')
    } finally { await h.close() }
  })

  it('answers structured questions once and preserves provider question keys', async () => {
    const h = await rig()
    try {
      const pending = h.options.canUseTool!('AskUserQuestion', { questions: [{ question: 'Which?', multiSelect: false, options: [{ label: 'A' }] }, { question: 'Extras?', multiSelect: true }] }, { signal: new AbortController().signal, toolUseID: 'tool-q', requestId: 'cli-q' })
      const event = h.events.find(event => event.type === 'question')!
      if (event.type !== 'question') throw new Error('No question event')
      expect(event.questions).toMatchObject([{ id: 'q1' }, { id: 'q2' }])
      await expect(h.connection.manage!('question.answer', { requestId: event.requestId, answers: { q1: ['A'] } })).rejects.toThrow('do not match')
      await h.connection.manage!('question.answer', { requestId: event.requestId, answers: { q1: ['A'], q2: ['extra', 'other'] } })
      expect(await pending).toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Which?': 'A', 'Extras?': ['extra', 'other'] } } })
      await expect(h.connection.manage!('question.answer', { requestId: event.requestId, answers: {} })).rejects.toThrow('no longer pending')
    } finally { await h.close() }
  })

  it('reports real context, model-specific efforts and wrapped MCP/task schemas', async () => {
    const h = await rig()
    try {
      expect(await h.connection.manage!('context', {})).toEqual({ usedTokens: 40, contextWindow: 100, remainingTokens: 60, percent: 40 })
      expect(await h.connection.manage!('settings', {})).toMatchObject({ options: [
        { key: 'model', choices: [{ value: 'custom-claude', label: 'Custom Claude' }] },
        { key: 'reasoningEffort', choices: [{ value: 'medium', label: 'medium' }, { value: 'high', label: 'high' }] },
        { key: 'fastMode' }, { key: 'permissionMode' },
      ] })
      await h.connection.manage!('option.set', { key: 'reasoningEffort', value: 'high' })
      expect(h.methods.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'high' })
      await expect(h.connection.manage!('option.set', { key: 'reasoningEffort', value: 'max' })).rejects.toThrow('current model')
      expect(await h.connection.manage!('mcp.list', {})).toEqual({ servers: [{ name: 'local', status: 'connected' }] })
      await h.connection.manage!('mcp.callback', { name: 'local', callbackUrl: 'https://example.com/callback?code=private' })
      expect(h.methods.mcpSubmitOAuthCallbackUrl).toHaveBeenCalledWith('local', 'https://example.com/callback?code=private')
      expect(await h.connection.manage!('tasks.list', {})).toEqual({ tasks: [] })
      expect(h.connection.managementOperations).not.toContain('accountUsage')
    } finally { await h.close() }
  })

  it('does not confuse a result or stop acknowledgement with provider/background idle', async () => {
    const h = await rig()
    try {
      await h.publish({ type: 'system', subtype: 'session_state_changed', state: 'running' })
      await h.publish({ type: 'result', subtype: 'success', is_error: false })
      expect(await h.connection.isIdle!()).toBe('busy')
      await h.publish({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
      await h.publish({ type: 'system', subtype: 'task_started', task_id: 'own-task', description: 'work' })
      await expect(h.connection.manage!('tasks.stop', { taskId: 'other-task' })).rejects.toThrow('does not belong')
      expect(await h.connection.manage!('tasks.stop', { taskId: 'own-task' })).toMatchObject({ requested: true, confirmed: false })
      expect(await h.connection.isIdle!()).toBe('busy')
      await h.publish({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
      expect(await h.connection.isIdle!()).toBe('idle')
    } finally { await h.close() }
  })

  it('sends compact as a command and suppresses its hidden conversational reply', async () => {
    const h = await rig()
    try {
      expect(h.connection.managementOperations).toContain('compact')
      expect(await h.connection.manage!('compact', { instructions: 'keep decisions' })).toMatchObject({ state: 'accepted' })
      expect(h.sent[0]?.message.content).toBe('/compact keep decisions')
      await h.publish({ type: 'assistant', uuid: 'hidden', message: { content: [{ type: 'text', text: 'hidden command response' }] } })
      expect(h.events.some(event => event.type === 'text')).toBe(false)
      await h.publish({ type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 500 } })
      expect(await h.connection.isIdle!()).toBe('busy')
      await h.publish({ type: 'result', subtype: 'success', is_error: false })
      expect(await h.connection.isIdle!()).toBe('idle')
    } finally { await h.close() }
  })

  it('only forks owned complete checkpoints and freezes old head after confirmed rewind', async () => {
    const history: ClaudeHistoryAccess = {
      messages: vi.fn(async () => [{ uuid: 'foreign', session_id: 'unrelated', parent_tool_use_id: null, type: 'assistant', message: { stop_reason: 'end_turn' } }]),
      fork: vi.fn(async () => 'new-provider'),
    }
    const h = await rig({}, history)
    try {
      await expect(h.connection.manage!('fork', { checkpointId: 'foreign' })).rejects.toThrow('does not belong')
      expect(history.fork).not.toHaveBeenCalled()
      await h.publish({ type: 'assistant', uuid: 'owned-checkpoint', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'done' }] } })
      await h.publish({ type: 'result', subtype: 'success', is_error: false })
      expect(await h.connection.manage!('rewind', { checkpointId: 'owned-checkpoint' })).toEqual({ providerSessionId: 'new-provider', checkpointId: 'owned-checkpoint', replacesProviderSessionId: 'provider-owned' })
      expect(history.fork).toHaveBeenCalledWith('provider-owned', '/owned/work', 'owned-checkpoint', undefined)
      expect(await h.connection.isIdle!()).toBe('unknown')
      await expect(h.connection.send({ messageId: 'late', text: 'not on retired head' })).rejects.toThrow('pending')
    } finally { await h.close() }
  })

  it('never repeats an uncertain transcript mutation', async () => {
    const history: ClaudeHistoryAccess = { messages: async () => [], fork: vi.fn(async () => { throw new Error('lost outcome') }) }
    const h = await rig({}, history)
    try {
      await expect(h.connection.manage!('fork', {})).rejects.toThrow('lost outcome')
      await expect(h.connection.manage!('fork', {})).rejects.toThrow('not confirmed idle')
      expect(history.fork).toHaveBeenCalledTimes(1)
    } finally { await h.close() }
  })
})
