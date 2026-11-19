import { describe, expect, it, vi } from 'vitest'
import { ManagedCodexAdapter } from '../src/managed-agents/codex-adapter.js'
import { codexSchemaMethods } from '../src/managed-agents/codex-schema.js'
import type { CodexAppServerLike, CodexAppServerInboundHandler } from '../src/codex/app-server.js'
import type { ManagedAgentEvent, ManagedAgentOpen } from '../src/managed-agents/types.js'

function fixture(methods: string[] = []) {
  let inbound: CodexAppServerInboundHandler = () => undefined
  const events: ManagedAgentEvent[] = []
  const routes: Record<string, (params: Record<string, unknown>) => unknown> = {
    'thread/start': () => ({ thread: { id: 'owned' }, model: 'configured', reasoningEffort: 'high', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite' } }),
    'thread/read': () => ({ thread: { id: 'owned', historyMode: 'paginated', status: { type: 'idle' } } }),
    'thread/turns/list': () => ({ data: [{ id: 'turn-2' }, { id: 'turn-1' }], nextCursor: null }),
    'thread/backgroundTerminals/list': () => ({ data: [], nextCursor: null }),
    'model/list': () => ({ data: [{ model: 'configured', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] }),
    'turn/start': () => ({ turn: { id: 'turn-3' } }),
    'turn/steer': () => ({ turnId: 'turn-3' }),
  }
  const client: CodexAppServerLike = {
    start: vi.fn(async () => undefined), isReady: () => true,
    discoverSupportedMethods: async () => new Set(methods),
    call: vi.fn(async (method, params) => {
      if (!routes[method]) throw Object.assign(new Error('not found'), { code: 'CODEX_METHOD_NOT_FOUND' })
      return routes[method]!(params as Record<string, unknown>)
    }),
    respond: vi.fn(async () => undefined), respondError: vi.fn(async () => undefined),
    onInbound: handler => { inbound = handler; return () => { inbound = () => undefined } },
    onUnavailable: () => () => undefined, close: vi.fn(async () => undefined),
  }
  const emit = (method: string, params: unknown, rpcId?: number) => inbound(rpcId === undefined
    ? { kind: 'notification', method, params } : { kind: 'request', method, params, id: rpcId })
  const open = (extra: Partial<ManagedAgentOpen> = {}) => new ManagedCodexAdapter(() => client).open({ sessionId: 'local', agent: 'codex', workspacePath: '/owned', ...extra }, event => events.push(event))
  return { client, routes, events, emit, open }
}

describe('Codex managed controls', () => {
  it('does not reclaim an idle foreground thread with background work or an active goal', async () => {
    const f = fixture(['thread/backgroundTerminals/list', 'thread/goal/get'])
    f.routes['thread/goal/get'] = () => ({ goal: { status: 'active' } })
    const connection = await f.open()
    expect(await connection.isIdle!()).toBe('busy')
    f.routes['thread/goal/get'] = () => ({ goal: { status: 'paused' } })
    expect(await connection.isIdle!()).toBe('idle')
    f.routes['thread/backgroundTerminals/list'] = () => ({ data: [{ processId: 'task' }], nextCursor: null })
    expect(await connection.isIdle!()).toBe('busy')
    await connection.close()
    const old = await fixture().open()
    expect(await old.isIdle!()).toBe('unknown')
    await old.close()
  })
  it('normalizes provider usage and skills into the native management view contract', async () => {
    const f = fixture(['account/rateLimits/read', 'skills/list'])
    f.routes['account/rateLimits/read'] = () => ({ rateLimitsByLimitId: { codex: { primary: { usedPercent: 12, resetsAt: 1800000000 }, secondary: null } } })
    f.routes['skills/list'] = () => ({ data: [{ cwd: '/owned', skills: [{ name: 'inspect', description: 'Inspect changes', enabled: true }, { name: 'disabled', enabled: false }] }] })
    const connection = await f.open()
    expect(await connection.manage!('accountUsage', {})).toEqual({ windows: [{ name: 'codex · primary', usedPercent: 12, resetsAt: new Date(1800000000000).toISOString() }] })
    expect(await connection.manage!('commands', {})).toEqual({ commands: [{ name: 'inspect', description: 'Inspect changes' }] })
    f.routes['account/rateLimits/read'] = () => ({ rateLimits: {} })
    expect(await connection.manage!('accountUsage', {})).toMatchObject({ windows: [], message: expect.any(String) })
    await connection.close()
  })
  it('requires exact acquired permission readback and never accepts an incomplete policy', async () => {
    const f = fixture()
    f.routes['thread/resume'] = () => ({ thread: { id: 'owned' }, approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'dangerFullAccess' } })
    const connection = await f.open({ providerSessionId: 'owned', permissionMode: 'danger-full-access' })
    expect(f.client.call).toHaveBeenCalledWith('thread/resume', expect.objectContaining({ threadId: 'owned', sandbox: 'danger-full-access', approvalPolicy: 'never', approvalsReviewer: 'user' }))
    await connection.close()
    const incomplete = fixture()
    incomplete.routes['thread/start'] = () => ({ thread: { id: 'owned' }, approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite' } })
    await expect(incomplete.open({ permissionMode: 'workspace-write' })).rejects.toThrow('CODEX_PERMISSION_ACQUISITION_UNCONFIRMED')
    expect(incomplete.client.close).toHaveBeenCalled()
    const legacy = fixture(['thread/goal/get', 'thread/goal/set', 'thread/settings/update'])
    legacy.routes['thread/start'] = () => ({ thread: { id: 'owned' } })
    const legacyConnection = await legacy.open()
    expect(legacyConnection.managementOperations).not.toContain('goal.set')
    expect(legacy.client.call).toHaveBeenCalledWith('thread/start', expect.objectContaining({ approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write' }))
    await legacyConnection.close()
    const wrong = fixture()
    await expect(wrong.open({ permissionMode: 'read-only' })).rejects.toThrow('CODEX_PERMISSION_ACQUISITION_UNCONFIRMED')
  })

  it('activates goals with confirmed non-default permissions but rejects an unacquired local change', async () => {
    const f = fixture(['thread/goal/get', 'thread/goal/set', 'thread/settings/update'])
    f.routes['thread/start'] = () => ({ thread: { id: 'owned' }, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly' } })
    f.routes['thread/goal/get'] = () => ({ goal: null })
    f.routes['thread/settings/update'] = () => { f.emit('thread/settings/updated', { threadId: 'owned', threadSettings: {} }); return {} }
    f.routes['thread/goal/set'] = () => ({ goal: { objective: 'Inspect', status: 'active' } })
    const connection = await f.open({ permissionMode: 'read-only' })
    await connection.manage!('goal.set', { objective: 'Inspect', operationId: 'goal-one' })
    expect(f.client.call).toHaveBeenCalledWith('thread/goal/set', { threadId: 'owned', origin: 'user', objective: 'Inspect', status: 'active' })
    await connection.setOption!('permissionMode', 'danger-full-access')
    expect(connection.managementOperations).not.toContain('goal.set')
    await expect(connection.manage!('goal.set', { objective: 'Inspect', operationId: 'goal-two' })).rejects.toThrow('CODEX_GOAL_PERMISSION_REACQUISITION_REQUIRED')
    await connection.close()
  })

  it('rejects invalid options before mutation and permits the same goal to pause without resetting it', async () => {
    const f = fixture(['thread/goal/get', 'thread/goal/set', 'thread/settings/update'])
    f.routes['thread/goal/get'] = () => ({ goal: { objective: 'Keep working', status: 'active' } })
    f.routes['thread/goal/set'] = () => ({ goal: { objective: 'Keep working', status: 'paused' } })
    const connection = await f.open()
    await expect(connection.manage!('option.set', { key: 'model', value: 'not-in-catalog' })).rejects.toMatchObject({ definiteRejection: true })
    expect(connection.defaultModel?.model).toBe('configured')
    await connection.manage!('goal.set', { objective: 'Keep working', status: 'paused', operationId: 'pause' })
    expect(f.client.call).toHaveBeenCalledWith('thread/goal/set', { threadId: 'owned', origin: 'user', status: 'paused' })
    expect(f.client.call).not.toHaveBeenCalledWith('thread/settings/update', expect.anything())
    await expect(connection.manage!('goal.set', { objective: 'Different', status: 'paused', operationId: 'replace' })).rejects.toMatchObject({ definiteRejection: true })
    await connection.close()
  })

  it('advertises only schema-confirmed provider methods and narrows on explicit refusal', async () => {
    const f = fixture(['thread/goal/get'])
    const connection = await f.open()
    expect(connection.managementOperations).toContain('goal.read')
    expect(connection.managementOperations).not.toContain('rewind')
    await expect(connection.manage!('goal.read', {})).rejects.toThrow('not found')
    expect(connection.managementOperations).not.toContain('goal.read')
    await connection.close()
  })

  it('delivers real deltas, images and steering without leaking foreign messages', async () => {
    const f = fixture(['turn/steer'])
    const connection = await f.open()
    await connection.send({ messageId: 'm1', text: 'Look', images: [{ mimeType: 'image/png', data: 'YWJj' }] })
    expect(f.client.call).toHaveBeenCalledWith('turn/start', expect.objectContaining({ threadId: 'owned', input: [{ type: 'text', text: 'Look' }, { type: 'image', url: 'data:image/png;base64,YWJj' }] }))
    f.emit('item/agentMessage/delta', { threadId: 'foreign', itemId: 'other', delta: 'secret' })
    f.emit('item/agentMessage/delta', { threadId: 'owned', itemId: 'item', delta: 'hello' })
    expect(f.events.filter(event => event.type === 'text-delta')).toEqual([{ type: 'text-delta', itemId: 'item', text: 'hello' }])
    expect(await connection.steer!({ messageId: 'm2', text: 'Change direction' })).toMatchObject({ state: 'accepted' })
    expect(f.client.call).toHaveBeenCalledWith('turn/steer', expect.objectContaining({ expectedTurnId: 'turn-3', threadId: 'owned', clientUserMessageId: 'm2' }))
    await connection.close()
  })

  it('answers only offered questions and consumes a request once', async () => {
    const f = fixture()
    const connection = await f.open()
    f.emit('item/tool/requestUserInput', { threadId: 'owned', questions: [{ id: 'q1', question: 'Which?' }, { id: 'q2', question: 'Why?' }] }, 7)
    const event = f.events.find(event => event.type === 'question')!
    if (event.type !== 'question') throw new Error('missing question')
    await expect(connection.manage!('question.answer', { requestId: event.requestId, answers: { q1: ['one'] } })).rejects.toThrow('every offered')
    await connection.manage!('question.answer', { requestId: event.requestId, answers: { q1: ['one'], q2: ['two'] } })
    expect(f.client.respond).toHaveBeenCalledWith(7, { answers: { q1: { answers: ['one'] }, q2: { answers: ['two'] } } })
    await expect(connection.manage!('question.answer', { requestId: event.requestId, answers: {} })).rejects.toThrow('no longer pending')
    await connection.close()
  })

  it('builds checkpoints only from the owned paginated thread and rejects foreign targets', async () => {
    const f = fixture(['thread/read', 'thread/turns/list', 'thread/revert'])
    f.routes['thread/revert'] = () => ({ thread: { id: 'owned' } })
    const connection = await f.open()
    expect(await connection.manage!('state', {})).toMatchObject({ checkpoints: [{ id: 'turn-2' }, { id: 'turn-1' }] })
    await expect(connection.manage!('rewind', { checkpointId: 'foreign', operationId: 'op' })).rejects.toThrow('INVALID_REWIND_TARGET')
    await expect(connection.manage!('rewind', { threadId: 'another', checkpointId: 'turn-2', operationId: 'op' })).rejects.toThrow('Foreign')
    await connection.manage!('rewind', { checkpointId: 'turn-2', operationId: 'op' })
    expect(f.client.call).toHaveBeenCalledWith('thread/revert', { threadId: 'owned', beforeTurnId: 'turn-2' })
    expect(f.client.call).not.toHaveBeenCalledWith('thread/list', expect.anything())
    await connection.close()
  })

  it('never repeats an unknown fork, and refuses legacy history', async () => {
    const f = fixture()
    f.routes['thread/fork'] = () => { throw new Error('response lost') }
    const connection = await f.open()
    await expect(connection.manage!('fork', { operationId: 'fork-once' })).rejects.toThrow('response lost')
    await expect(connection.manage!('fork', { operationId: 'fork-once' })).rejects.toThrow('OUTCOME_UNKNOWN')
    expect(vi.mocked(f.client.call).mock.calls.filter(([method]) => method === 'thread/fork')).toHaveLength(1)
    f.routes['thread/read'] = () => ({ thread: { id: 'owned', historyMode: 'legacy', status: { type: 'idle' } } })
    await expect(connection.manage!('rewind', { checkpointId: 'turn-2', operationId: 'new' })).rejects.toThrow('PAGINATED_HISTORY_REQUIRED')
    await connection.close()
  })

  it('fork returns new identity without importing or resuming its history', async () => {
    const f = fixture()
    f.routes['thread/fork'] = () => ({ thread: { id: 'owned-fork' } })
    const connection = await f.open()
    expect(await connection.manage!('fork', { checkpointId: 'turn-2', operationId: 'fork' })).toMatchObject({ providerSessionId: 'owned-fork', checkpointId: 'turn-2' })
    expect(f.client.call).toHaveBeenCalledWith('thread/fork', { threadId: 'owned', beforeTurnId: 'turn-2', excludeTurns: true, cwd: '/owned' })
    expect(f.client.call).not.toHaveBeenCalledWith('thread/resume', expect.anything())
    await connection.close()
  })

  it('keeps context unknown until measured and applies the latest turn token usage', async () => {
    const f = fixture()
    const connection = await f.open()
    expect(await connection.manage!('context', {})).toMatchObject({ available: false })
    f.emit('thread/tokenUsage/updated', { threadId: 'owned', tokenUsage: { last: { totalTokens: 250 }, total: { totalTokens: 9999 }, modelContextWindow: 1000 } })
    expect(await connection.manage!('context', {})).toEqual({ available: true, usedTokens: 250, contextWindow: 1000, remainingTokens: 750, percent: 25 })
    await connection.close()
  })

  it('requires confirmed goal settings before activating and rejects unsupported budget', async () => {
    const f = fixture()
    f.routes['thread/goal/get'] = () => ({ goal: null })
    f.routes['thread/settings/update'] = () => {
      f.emit('thread/settings/updated', { threadId: 'owned', threadSettings: { model: 'configured', effort: 'high' } })
      return {}
    }
    f.routes['thread/goal/set'] = () => ({ goal: { status: 'active' } })
    const connection = await f.open()
    await expect(connection.manage!('goal.set', { objective: 'Work', tokenBudget: 10, operationId: 'budget' })).rejects.toThrow('budget')
    await connection.manage!('goal.set', { objective: 'Work', operationId: 'goal' })
    expect(f.client.call).toHaveBeenCalledWith('thread/goal/set', { threadId: 'owned', origin: 'user', objective: 'Work', status: 'active' })
    await connection.close()
  })

  it('only stops a terminal returned by this thread and confirms its disappearance', async () => {
    const f = fixture()
    let running = true
    f.routes['thread/backgroundTerminals/list'] = () => ({ data: running ? [{ processId: 'proc' }] : [], nextCursor: null })
    f.routes['thread/backgroundTerminals/terminate'] = () => { running = false; return { terminated: true } }
    const connection = await f.open()
    await expect(connection.manage!('tasks.stop', { taskId: 'foreign' })).rejects.toThrow('not owned')
    expect(await connection.manage!('tasks.stop', { taskId: 'proc' })).toEqual({ stopped: true })
    expect(f.client.call).toHaveBeenCalledWith('thread/backgroundTerminals/terminate', { threadId: 'owned', processId: 'proc' })
    await connection.close()
  })

  it('tracks only announced subagents and never imports their messages as parent text', async () => {
    const f = fixture()
    f.routes['thread/read'] = params => ({ thread: { id: params.threadId, historyMode: 'paginated', status: { type: params.threadId === 'child' ? 'active' : 'idle' } } })
    f.routes['thread/turns/list'] = () => ({ data: [{ id: 'child-turn', status: 'inProgress' }], nextCursor: null })
    const connection = await f.open()
    f.emit('item/completed', { threadId: 'owned', item: { type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['child'], prompt: 'Review' } })
    f.emit('turn/started', { threadId: 'child', turn: { id: 'child-turn' } })
    f.emit('item/agentMessage/delta', { threadId: 'child', itemId: 'c', delta: 'child private text' })
    f.emit('turn/started', { threadId: 'foreign', turn: { id: 'foreign-turn' } })
    expect(await connection.manage!('tasks.list', {})).toMatchObject({ tasks: [{ id: 'child', status: 'working', turnId: 'child-turn' }] })
    expect(f.events.filter(event => event.type === 'text-delta')).toHaveLength(0)
    await expect(connection.manage!('compact', { operationId: 'compact' })).rejects.toThrow('BACKGROUND_WORK_ACTIVE')
    await connection.close()
  })

  it('restores only journal children rooted at this provider and rechecks live turns before stopping descendants', async () => {
    const f = fixture()
    const running = new Set(['child', 'grandchild'])
    const terminals = new Set(['child'])
    f.routes['thread/read'] = params => ({ thread: { id: params.threadId, status: { type: running.has(String(params.threadId)) ? 'active' : 'idle' } } })
    f.routes['thread/turns/list'] = params => ({ data: [{ id: `${params.threadId}-live-turn`, status: 'inProgress' }], nextCursor: null })
    f.routes['turn/interrupt'] = params => { running.delete(String(params.threadId)); return {} }
    f.routes['thread/backgroundTerminals/list'] = params => ({ data: terminals.has(String(params.threadId)) ? [{ processId: 'child-process' }] : [], nextCursor: null })
    f.routes['thread/backgroundTerminals/terminate'] = params => { terminals.delete(String(params.threadId)); return {} }
    const connection = await f.open({ restoredChildren: [
      { id: 'grandchild', parentThreadId: 'child', title: 'Grandchild', status: 'working', turnId: 'old-turn' },
      { id: 'child', parentThreadId: 'owned', title: 'Child', status: 'working', turnId: 'old-turn' },
      { id: 'foreign', parentThreadId: 'other-root', title: 'Foreign', status: 'working' },
    ] })
    expect(await connection.manage!('tasks.stop', { taskId: 'child' })).toEqual({ accepted: true, stopped: true })
    expect(f.client.call).toHaveBeenCalledWith('turn/interrupt', { threadId: 'child', turnId: 'child-live-turn' })
    expect(f.client.call).toHaveBeenCalledWith('turn/interrupt', { threadId: 'grandchild', turnId: 'grandchild-live-turn' })
    expect(f.client.call).toHaveBeenCalledWith('thread/backgroundTerminals/terminate', { threadId: 'child', processId: 'child-process' })
    expect(vi.mocked(f.client.call).mock.calls.some(([, params]) => (params as { threadId?: string })?.threadId === 'foreign')).toBe(false)
    await connection.close()
  })

  it('marks preflight refusals definite but never marks dispatched unknown mutations definite', async () => {
    const f = fixture()
    f.routes['thread/fork'] = () => { throw new Error('lost') }
    const connection = await f.open()
    await expect(connection.manage!('goal.set', { objective: 'Work', tokenBudget: 2 })).rejects.toMatchObject({ definiteRejection: true })
    await expect(connection.manage!('fork', { operationId: 'once' })).rejects.not.toHaveProperty('definiteRejection')
    await expect(connection.manage!('fork', { operationId: 'once' })).rejects.not.toHaveProperty('definiteRejection')
    await connection.close()
  })

  it('refuses foreign MCP callbacks without making an HTTP request', async () => {
    const f = fixture()
    f.routes['mcpServer/oauth/login'] = () => ({ authorizationUrl: 'https://login.example.test/?redirect_uri=http%3A%2F%2F127.0.0.1%3A43210%2Fcallback&state=expected' })
    const connection = await f.open()
    await connection.manage!('mcp.authenticate', { name: 'test' })
    await expect(connection.manage!('mcp.callback', { name: 'test', callbackUrl: 'http://169.254.169.254/callback?state=expected' })).rejects.toThrow('does not match')
    await expect(connection.manage!('mcp.callback', { name: 'test', callbackUrl: 'http://127.0.0.1:43210/callback?state=wrong' })).rejects.toThrow('does not match')
    await connection.close()
  })
})

describe('Codex schema capability reader', () => {
  it('extracts only declared method enums/const, never incidental descriptions', () => {
    expect(codexSchemaMethods({ anyOf: [{ properties: { method: { enum: ['thread/revert'] } } }, { properties: { method: { const: 'turn/steer' } } }], description: 'thread/fork' })).toEqual(new Set(['thread/revert', 'turn/steer']))
  })
})
