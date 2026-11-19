import { describe, expect, it } from 'vitest'
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { ManagedClaudeAdapter, type ClaudeQueryFactory } from '../src/managed-agents/claude-adapter.js'
import { createClaudeUserMessageQueue, claudeUserMessageWasProvablyUnwritten } from '../src/managed-agents/claude-message-queue.js'
import type { ManagedAgentEvent } from '../src/managed-agents/types.js'

describe('Orca Claude management extraction', () => {
  it('distinguishes an unwritten message from an ambiguous in-flight write', async () => {
    const queue = createClaudeUserMessageQueue()
    const first = queue.push({ type: 'user', session_id: 's', parent_tool_use_id: null, message: { role: 'user', content: 'one' } }).catch(error => error)
    const iterator = queue.messages[Symbol.asyncIterator]()
    await iterator.next()
    const second = queue.push({ type: 'user', session_id: 's', parent_tool_use_id: null, message: { role: 'user', content: 'two' } }).catch(error => error)
    queue.fail(new Error('closed'))
    expect(claudeUserMessageWasProvablyUnwritten(await first)).toBe(false)
    expect(claudeUserMessageWasProvablyUnwritten(await second)).toBe(true)
    await iterator.return?.()
  })

  it('uses local settings, persists the exact resume identity, and handles explicit approval without Orca', async () => {
    let options!: Options
    let finish!: () => void
    let promptPump: Promise<void> | undefined
    const events: ManagedAgentEvent[] = []
    const factory: ClaudeQueryFactory = input => {
      options = input.options
      promptPump = (async () => { for await (const message of input.prompt) { expect(message.message.content).toBe('hello') } })()
      return {
        initializationResult: async () => ({}), close: () => finish(),
        async *[Symbol.asyncIterator]() {
          await new Promise<void>(resolve => { finish = resolve })
        },
      } as unknown as Query
    }
    const connection = await new ManagedClaudeAdapter(factory).open({ sessionId: 'managed', agent: 'claude', workspacePath: '/work/a', providerSessionId: 'existing-provider-session' }, event => events.push(event))
    expect(options.resume).toBe('existing-provider-session')
    expect(options.settingSources).toEqual(['user', 'project', 'local'])
    expect(options.pathToClaudeCodeExecutable).toBe('claude')
    expect(options.permissionMode).toBe('default')
    expect(await connection.send({ messageId: 'msg', text: 'hello' })).toEqual({ state: 'accepted', providerTurnId: 'msg' })
    const pending = options.canUseTool!('Bash', { command: 'pwd' }, { signal: new AbortController().signal, toolUseID: 'tool-1', requestId: 'provider-request-1' })
    const approval = events.find(event => event.type === 'approval')!
    if (approval.type !== 'approval') throw new Error('missing approval')
    await connection.approve(approval.requestId, 'reject-once')
    expect(await pending).toMatchObject({ behavior: 'deny', interrupt: false })
    await expect(connection.approve(approval.requestId, 'allow-once')).rejects.toThrow('no longer pending')
    await connection.close()
    await promptPump
  })

  it('publishes complete assistant text separately from thinking and tools', async () => {
    let release!: () => void
    const factory: ClaudeQueryFactory = () => ({
      initializationResult: async () => ({}), close: () => release(),
      async *[Symbol.asyncIterator]() {
        yield { type: 'assistant', uuid: 'answer', message: { content: [{ type: 'thinking', thinking: 'reason' }, { type: 'text', text: 'answer' }, { type: 'tool_use', id: 'tool', name: 'Read', input: {} }] } } as unknown as SDKMessage
        await new Promise<void>(resolve => { release = resolve })
      },
    }) as unknown as Query
    const events: ManagedAgentEvent[] = []
    const connection = await new ManagedClaudeAdapter(factory).open({ sessionId: 'managed', agent: 'claude', workspacePath: '/work/a' }, event => events.push(event))
    expect(events).toEqual([
      { type: 'reasoning', text: 'reason', itemId: 'claude:/:block:answer:0' }, { type: 'text', text: 'answer', itemId: 'claude:/:block:answer:1' },
      { type: 'tool', itemId: 'tool', name: 'Read', status: 'running', data: { type: 'tool_use', id: 'tool', name: 'Read', input: {} } },
    ])
    await connection.close()
  })

  it('reads the exact applied Claude settings without guessing from catalog order', async () => {
    let finish!: () => void
    const factory: ClaudeQueryFactory = () => ({
      initializationResult: async () => ({ models: [{ value: 'wrong-first-model' }] }),
      getSettings: async () => ({ applied: { model: 'configured-custom-model', effort: 'high' } }),
      close: () => finish(),
      async *[Symbol.asyncIterator]() { await new Promise<void>(resolve => { finish = resolve }) },
    }) as unknown as Query
    const connection = await new ManagedClaudeAdapter(factory).open({ sessionId: 'managed', agent: 'claude', workspacePath: '/work/a' }, () => undefined)
    expect(connection.defaultModel).toEqual({ model: 'configured-custom-model', reasoningEffort: 'high' })
    await connection.close()
  })

  it('observes a later Claude init model through the connection getter', async () => {
    let publish!: () => void
    let finish!: () => void
    const factory: ClaudeQueryFactory = () => ({
      initializationResult: async () => ({}), close: () => finish(),
      async *[Symbol.asyncIterator]() {
        await new Promise<void>(resolve => { publish = resolve })
        yield { type: 'system', subtype: 'init', model: 'observed-model' } as SDKMessage
        await new Promise<void>(resolve => { finish = resolve })
      },
    }) as unknown as Query
    const connection = await new ManagedClaudeAdapter(factory).open({ sessionId: 'managed', agent: 'claude', workspacePath: '/work/a' }, () => undefined)
    expect(connection.defaultModel).toBeUndefined()
    publish()
    await new Promise(resolve => setImmediate(resolve))
    expect(connection.defaultModel).toEqual({ model: 'observed-model' })
    await connection.close()
  })
})
