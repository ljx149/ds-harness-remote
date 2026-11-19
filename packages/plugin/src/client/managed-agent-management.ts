import type { ClientReact } from './types.js'
import type { ManagedAgentUiContext } from './managed-agent.js'

type Row = Record<string, unknown>
const row = (value: unknown): Row => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Row : {}
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(row) : []
const text = (value: unknown): string => typeof value === 'string' ? value : ''
const finite = (value: unknown): string => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '—'

/** Keep one receipt identity until acknowledgement. A lost response must not
 * turn a retry into a second compact/fork/answer. Closing a viewer does not stop work. */
export interface ManagementIntentStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}
const browserStorage = (): ManagementIntentStorage | undefined => { try { return globalThis.sessionStorage } catch { return undefined } }
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Row)[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
const digest = async (value: string): Promise<string> => {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}
export class ManagedManagementAttempts {
  private readonly pending = new Map<string, string>()
  constructor(private readonly uuid: () => string = () => crypto.randomUUID(), private readonly storage: () => ManagementIntentStorage | undefined = browserStorage) {}
  async begin(sessionId: string, operation: string, payload: Row): Promise<{ key: string; operationId: string; persistent: boolean }> {
    // Only the digest and operation UUID reach browser storage, never answers,
    // authorization callback codes, model settings or the session ID itself.
    const key = `xcodex-management-intent:v1:${await digest(canonical([sessionId, operation, payload]))}`
    let persistent = false
    let operationId = this.pending.get(key)
    try { operationId ??= this.storage()?.getItem(key) ?? undefined } catch { /* blocked storage keeps the in-page identity */ }
    operationId ??= this.uuid()
    this.pending.set(key, operationId)
    try { const storage = this.storage(); storage?.setItem(key, operationId); persistent = storage !== undefined } catch { /* memory fallback; UI warns before refresh */ }
    return { key, operationId, persistent }
  }
  acknowledged(key: string): void {
    this.pending.delete(key)
    try { this.storage()?.removeItem(key) } catch { /* backend receipt still prevents re-execution */ }
  }
}

/** DSH 0.2.2 exposes the retained concrete Session through binding(). Its
 * resync() rebuilds the event source; list refresh alone cannot remove rewound
 * messages. Feature-detect because the outward SessionFace omits this method. */
export async function refreshManagedNativeHistory(sessions: unknown, sessionId: string): Promise<boolean> {
  const service = sessions as { binding?(id: string): { session?: { resync?: () => Promise<void> } }; refreshProjections?(id: string): Promise<void> }
  const session = service.binding?.(sessionId)?.session
  if (typeof session?.resync !== 'function') return false
  await session.resync()
  await service.refreshProjections?.(sessionId)
  return true
}

export function createManagedAgentManagementUi(React: ClientReact, ctx: ManagedAgentUiContext) {
  const h = React.createElement
  const attempts = new ManagedManagementAttempts()
  const t = (zh: string, en: string) => ctx.chinese ? zh : en
  const button = (label: string, onClick: () => void, disabled = false) => h('button', { type: 'button', disabled, onClick, style: { padding: '6px 10px', margin: '4px 4px 4px 0' } }, label)
  function Management(): unknown {
    const [, changed] = React.useState(0)
    React.useEffect(() => ctx.sessions.list.subscribe(() => changed(n => n + 1)), [])
    const current = Object.values(ctx.sessions.list.getSnapshot().byId ?? {}).find(item => (item.retainedBy?.mainView ?? 0) > 0)
    const sessionId = current?.id
    const [identified, setIdentified] = React.useState<string | undefined>(undefined)
    const [expanded, setExpanded] = React.useState(false)
    const [discovery, setDiscovery] = React.useState<Row>({})
    const [results, setResults] = React.useState<Record<string, Row>>({})
    const [error, setError] = React.useState('')
    const [working, setWorking] = React.useState(false)
    const [instructions, setInstructions] = React.useState('')
    const [goal, setGoal] = React.useState('')
    const [checkpoint, setCheckpoint] = React.useState('')
    const [answers, setAnswers] = React.useState<Record<string, Record<string, string[]>>>({})
    const [profile, setProfile] = React.useState('')
    const [location, setLocation] = React.useState('')
    const [storageWarning, setStorageWarning] = React.useState(false)
    const [callbacks, setCallbacks] = React.useState<Record<string, string>>({})
    const dialog = React.useRef<HTMLDialogElement | null>(null)
    const active = React.useRef<string | undefined>(sessionId)
    const mutation = React.useRef(false)
    const refreshing = React.useRef(false)
    active.current = sessionId
    React.useEffect(() => () => { active.current = undefined }, [])
    React.useEffect(() => {
      let live = true
      setIdentified(undefined); setWorking(false); setExpanded(false); setDiscovery({}); setResults({}); setError(''); setAnswers({}); setCheckpoint(''); setInstructions(''); setGoal(''); setProfile(''); setLocation(''); setCallbacks({})
      if (!sessionId) return
      if (typeof row(current?.projections?.values?.managedAgent).agentId === 'string') { setIdentified(sessionId); return }
      void ctx.call('managedAgent/catalog', {}).then(value => {
        const items = Array.isArray(value) ? rows(value) : rows(row(value).items)
        if (live && items.some(item => item.sessionId === sessionId && typeof item.agentId === 'string')) setIdentified(sessionId)
      }).catch(() => {})
      return () => { live = false }
    }, [sessionId])
    const refresh = async (): Promise<void> => {
      if (!sessionId || refreshing.current) return
      refreshing.current = true
      const captured = sessionId
      try {
        const next = row(await ctx.call('managedAgent/management', { request: { sessionId: captured } }))
        if (active.current === captured) { setDiscovery(next); setError('') }
      } catch (reason) { if (active.current === captured) setError(reason instanceof Error ? reason.message : String(reason)) }
      finally { refreshing.current = false }
    }
    React.useEffect(() => {
      if (!expanded) { dialog.current?.close(); return }
      dialog.current?.showModal()
      void refresh()
      const timer = setInterval(() => { if (!mutation.current) void refresh() }, 5000)
      return () => { clearInterval(timer); dialog.current?.close() }
    }, [expanded, sessionId])
    const operations = Array.isArray(discovery.operations) ? discovery.operations.filter((op): op is string => typeof op === 'string') : []
    const has = (op: string) => operations.includes(op)
    const state = row(discovery.state)
    const checkpoints = rows(state.checkpoints)
    const run = async (operation: string, payload: Row = {}, read = false): Promise<void> => {
      if (!sessionId || mutation.current || !has(operation)) return
      const captured = sessionId
      mutation.current = true; setWorking(true); setError('')
      let receipt: Awaited<ReturnType<ManagedManagementAttempts['begin']>> | undefined
      try {
        receipt = read ? undefined : await attempts.begin(captured, operation, payload)
        if (receipt && !receipt.persistent) setStorageWarning(true)
        const unresolved = rows(row(discovery.state).unresolvedOperations)
        if (!read && unresolved.some(item => item.operationId !== receipt?.operationId)) {
          if (receipt && !unresolved.some(item => item.operationId === receipt?.operationId)) attempts.acknowledged(receipt.key)
          throw new Error(t('此会话有结果未确认的操作，请先核对原操作，不能提交新的修改。', 'This session has an unresolved operation. Reconcile it before submitting a new mutation.'))
        }
        if (active.current !== captured) return
        const result = row(await ctx.call('managedAgent/manage', { request: { sessionId: captured, operation, ...(receipt ? { operationId: receipt.operationId } : {}), payload } }))
        if (receipt) attempts.acknowledged(receipt.key)
        if (active.current === captured) {
          setResults(previous => ({ ...previous, [operation]: result }))
          if (operation === 'mcp.callback') setCallbacks(previous => ({ ...previous, [text(payload.name)]: '' }))
          if (operation === 'fork' && typeof result.sessionId === 'string') { await ctx.sessions.refresh?.(); if (active.current === captured) ctx.open(result.sessionId) }
          await refresh()
          if (operation === 'rewind' && active.current === captured) {
            try {
              if (!await refreshManagedNativeHistory(ctx.sessions, captured)) setError(t('回退已完成，但当前 DSH 版本无法直接刷新历史；请重新打开此会话，不要重复回退。', 'Rewind completed, but this DSH version cannot refresh history directly. Reopen the session; do not rewind again.'))
            } catch { setError(t('回退已完成，历史刷新失败，请重新打开会话，不要重复操作。', 'Rewind completed; history refresh failed. Reopen the session without repeating the operation.')) }
          }
        }
      } catch (reason) { if (active.current === captured) setError(reason instanceof Error ? reason.message : String(reason)) }
      finally { mutation.current = false; if (active.current === captured) setWorking(false) }
    }
    if (!sessionId || identified !== sessionId) return null
    const busy = working || discovery.busy === true
    const section = (title: string, ...children: unknown[]) => h('section', { style: { borderTop: '1px solid #8885', padding: '10px 0' } }, h('h3', { style: { margin: '4px 0', fontSize: '1rem' } }, title), ...children)
    const field = (label: string, value: string, change: (value: string) => void, multiline = false) => h('label', { style: { display: 'block', margin: '8px 0' } }, label,
      h(multiline ? 'textarea' : 'input', { value, disabled: working, onChange: (event: { target: { value: string } }) => change(event.target.value), style: { display: 'block', width: '100%', boxSizing: 'border-box', padding: 6 } }))
    const context = results.context ?? row(state.context)
    const usage = results.accountUsage ?? row(state.accountUsage)
    const settings = results.settings ?? row(state.settings)
    const mcpAuthUrl = results['mcp.authenticate']?.authUrl ?? results['mcp.authenticate']?.authorizationUrl
    const mcp = results['mcp.list'] ?? row(state.mcp)
    const tasks = results['tasks.list'] ?? row(state.tasks)
    const launch = results['launch.options'] ?? row(state.launch)
    const currentGoal = row(results['goal.read']?.goal ?? state.goal)
    const select = (label: string, value: string, options: Row[], choose: (value: string) => void, disabled = false) => h('label', { style: { display: 'block', margin: '8px 0' } }, label,
      h('select', { value, disabled: working || disabled, onChange: (event: { target: { value: string } }) => choose(event.target.value), style: { width: '100%', padding: 6 } }, h('option', { value: '' }, t('请选择', 'Select')),
        ...options.map(option => h('option', { key: text(option.id ?? option.value), value: text(option.id ?? option.value) }, text(option.title ?? option.label ?? option.name ?? option.id ?? option.value)))))
    return h(React.Fragment, null,
      button(t('Agent 管理', 'Manage Agent'), () => setExpanded(true)),
      h('dialog', { ref: dialog, onCancel: () => setExpanded(false), onClose: () => setExpanded(false), style: { color: 'inherit', background: 'var(--background, Canvas)', border: '1px solid #8887', borderRadius: 12, padding: 18, width: 'min(620px, calc(100vw - 40px))', maxHeight: '85dvh', overflowY: 'auto', boxSizing: 'border-box' } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, h('h2', { style: { margin: 0 } }, t('Agent 管理', 'Agent management')), button(t('关闭', 'Close'), () => setExpanded(false))),
        h('p', { role: 'status' }, discovery.busy === true ? t('正在执行任务；关闭面板不会停止任务。', 'A task is running. Closing this panel does not stop it.') : text(row(state.lifecycle).state)),
        button(t('刷新状态', 'Refresh state'), () => { void refresh() }, working),
        error ? h('p', { role: 'alert' }, error) : null,
        storageWarning ? h('p', { role: 'alert' }, t('浏览器无法保存操作回执；若结果不确定，请勿刷新页面后重复提交。', 'Browser receipt storage is unavailable. Do not reload and resubmit an uncertain operation.')) : null,
        rows(state.unresolvedOperations).length ? section(t('待确认的操作', 'Unresolved operations'), h('p', null, t('以下操作结果尚未确认。仅可用完全相同的原输入重试，不能发起新的修改。', 'Results are not yet confirmed. Retry only with the exact original input; do not initiate a new mutation.')),
          ...rows(state.unresolvedOperations).map(item => h('p', { key: text(item.operationId) }, `${text(item.operation)} · ${text(item.status)}`))) : null,
        typeof state.unsupportedReason === 'string' ? h('p', { role: 'status' }, state.unsupportedReason) : null,
        !operations.length ? h('p', null, t('正在读取可用管理能力，或当前版本未提供管理能力。', 'Reading available controls, or this version has no management controls.')) : null,
        has('launch.open') ? section(t('启动 Agent', 'Start Agent'),
          h('p', null, t('可以先选择下方账号配置和执行位置，再启动并读取此 Agent 的实际能力。', 'Choose the account profile and execution location below before starting and reading this Agent’s capabilities.')),
          button(t('启动 Agent 并读取能力', 'Start Agent and read capabilities'), () => { void run('launch.open') }, busy)) : null,
        has('context') || has('accountUsage') ? section(t('用量', 'Usage'),
          has('context') ? button(t('读取上下文', 'Read context'), () => { void run('context', {}, true) }, working) : null,
          has('accountUsage') ? button(t('读取账号额度', 'Read account usage'), () => { void run('accountUsage', {}, true) }, working) : null,
          Object.keys(context).length ? h('p', null, `${t('上下文已用 / 上限', 'Context used / window')}: ${finite(context.usedTokens)} / ${finite(context.contextWindow)} · ${t('剩余', 'Remaining')}: ${finite(context.remainingTokens)}`) : null,
          typeof context.message === 'string' ? h('p', null, context.message) : null,
          ...rows(usage.windows).map((item, index) => h('p', { key: index }, `${text(item.name)} ${finite(item.usedPercent)}%${item.resetsAt ? ` · ${t('重置', 'Resets')}: ${text(item.resetsAt)}` : ''}`)),
          typeof usage.message === 'string' ? h('p', null, usage.message) : null) : null,
        has('settings') ? section(t('执行设置', 'Execution settings'),
          button(t('读取设置', 'Read settings'), () => { void run('settings', {}, true) }, working),
          ...['model', 'reasoningEffort', 'permissionMode'].filter(key => typeof settings[key] === 'string').map(key => h('p', { key }, `${({ model: t('模型', 'Model'), reasoningEffort: t('推理强度', 'Reasoning effort'), permissionMode: t('权限模式', 'Permission mode') } as Record<string, string>)[key]}: ${settings[key]}`)),
          ...rows(settings.options).filter(option => typeof option.key === 'string' && rows(option.choices).length > 0).map(option => h('div', { key: text(option.key) },
            select(text(option.label ?? option.key), text(option.value), rows(option.choices), value => { if (value && has('option.set')) void run('option.set', { key: option.key, value }) }, !has('option.set'))))) : null,
        has('commands') ? section(t('可用命令', 'Available commands'), button(t('读取命令', 'Read commands'), () => { void run('commands', {}, true) }, working),
          ...rows(results.commands?.commands).map(command => h('p', { key: text(command.name) }, h('strong', null, text(command.name)), ` ${text(command.argumentHint)} — ${text(command.description)}`))) : null,
        has('compact') ? section(t('压缩上下文', 'Compact context'),
          state.compactInstructions === true ? field(t('摘要要求（可选）', 'Summary instructions (optional)'), instructions, setInstructions, true) : h('p', null, t('当前 Agent 不接受额外压缩要求。', 'This Agent does not accept compaction instructions.')),
          button(t('开始压缩', 'Compact'), () => { void run('compact', state.compactInstructions === true && instructions.trim() ? { instructions: instructions.trim() } : {}) }, busy)) : null,
        has('rewind') || has('fork') ? section(t('对话检查点', 'Conversation checkpoints'),
          results.rewind ? h('p', null, t('已回退 Agent 上下文。原消息保留为历史记录。', 'Agent context rewound. Earlier messages remain in the audit history.')) : null,
          select(t('选择真实检查点', 'Choose a checkpoint'), checkpoint, checkpoints, setCheckpoint),
          has('rewind') ? button(t('回退到此检查点', 'Rewind to checkpoint'), () => { void run('rewind', { checkpointId: checkpoint }) }, busy || !checkpoints.some(item => item.id === checkpoint)) : null,
          has('fork') ? button(t('分叉为新会话', 'Fork into new session'), () => { void run('fork', checkpoint ? { checkpointId: checkpoint } : {}) }, busy || (!!checkpoint && !checkpoints.some(item => item.id === checkpoint))) : null) : null,
        has('goal.read') || has('goal.set') ? section(t('线程目标', 'Thread goal'),
          has('goal.read') ? button(t('读取目标', 'Read goal'), () => { void run('goal.read', {}, true) }, working) : null,
          text(currentGoal.objective) ? h('p', null, `${text(currentGoal.objective)} · ${text(currentGoal.status)}`) : null,
          has('goal.set') ? field(t('新目标', 'New objective'), goal, setGoal, true) : null,
          has('goal.set') ? button(t('设置目标', 'Set goal'), () => { void run('goal.set', { objective: goal.trim() }) }, busy || !goal.trim()) : null,
          has('goal.set') && currentGoal.status === 'active' ? button(t('暂停目标', 'Pause goal'), () => { void run('goal.set', { status: 'paused' }) }, busy) : null,
          has('goal.set') && currentGoal.status === 'paused' ? button(t('继续目标', 'Resume goal'), () => { void run('goal.set', { status: 'active' }) }, busy) : null,
          has('goal.clear') ? button(t('清除目标', 'Clear goal'), () => { void run('goal.clear') }, busy) : null) : null,
        typeof mcpAuthUrl === 'string' && /^https?:\/\//i.test(mcpAuthUrl) ?
          h('p', null, h('a', { href: mcpAuthUrl, target: '_blank', rel: 'noreferrer noopener' }, t('继续 MCP 授权', 'Continue MCP authorization'))) : null,
        has('mcp.list') ? section('MCP', button(t('读取服务器', 'Read servers'), () => { void run('mcp.list', {}, true) }, working),
          ...rows(mcp.servers).map(server => h('div', { key: text(server.name) }, h('p', null, `${text(server.name)} · ${text(server.status)}`),
            has('mcp.reconnect') ? button(t('重连', 'Reconnect'), () => { void run('mcp.reconnect', { name: server.name }) }, working) : null,
            has('mcp.toggle') && typeof server.enabled === 'boolean' ? button(server.enabled ? t('停用', 'Disable') : t('启用', 'Enable'), () => { void run('mcp.toggle', { name: server.name, enabled: !server.enabled }) }, working) : null,
            has('mcp.authenticate') ? button(t('授权', 'Authorize'), () => { void run('mcp.authenticate', { name: server.name }) }, working) : null,
            has('mcp.callback') ? h('div', null,
              field(t('授权回跳地址', 'Authorization callback URL'), callbacks[text(server.name)] ?? '', value => setCallbacks(previous => ({ ...previous, [text(server.name)]: value }))),
              button(t('完成授权回跳', 'Complete authorization callback'), () => { void run('mcp.callback', { name: server.name, callbackUrl: callbacks[text(server.name)]?.trim() }) }, working || !callbacks[text(server.name)]?.trim())) : null,
            typeof server.authUrl === 'string' && /^https?:\/\//i.test(server.authUrl) ? h('a', { href: server.authUrl, target: '_blank', rel: 'noreferrer noopener' }, t('打开授权页面', 'Open authorization page')) : null)),
          has('mcp.reload') ? button(t('重新加载配置', 'Reload configuration'), () => { void run('mcp.reload') }, working) : null) : null,
        has('tasks.list') ? section(t('后台任务', 'Background tasks'), button(t('读取任务', 'Read tasks'), () => { void run('tasks.list', {}, true) }, working),
          ...rows(tasks.tasks).map(task => h('div', { key: text(task.id) }, h('p', null, `${text(task.title ?? task.id)} · ${text(task.status)}`),
            has('tasks.stop') ? button(t('停止此任务', 'Stop task'), () => { void run('tasks.stop', { taskId: task.id }) }, working) : null,
            has('tasks.background') && typeof task.toolUseId === 'string' ? button(t('转为后台', 'Run in background'), () => { void run('tasks.background', { toolUseId: task.toolUseId }) }, working) : null))) : null,
        rows(state.queued).length || has('queue.run') ? section(t('消息队列', 'Message queue'),
          ...rows(state.queued).map(item => h('div', { key: text(item.requestId) },
            h('p', null, text(item.text)), h('p', null, text(item.state)),
            item.state === 'dispatching' || item.state === 'unknown' ? h('p', { role: 'status' }, t('此消息可能已经投递，请核对会话结果，不要重复发送。', 'This message may already have been delivered. Check the conversation; do not send it again.')) : null,
            item.state === 'queued' && has('queue.remove') ? button(t('移出队列', 'Remove from queue'), () => { void run('queue.remove', { requestId: item.requestId }) }, working) : null)),
          has('queue.run') ? button(t('恢复队列', 'Resume queue'), () => { void run('queue.run') }, busy || rows(state.queued).some(item => item.state === 'dispatching' || item.state === 'unknown')) : null) : null,
        has('question.answer') ? section(t('Agent 提问', 'Agent questions'), ...rows(state.questions).map(question => {
          const requestId = text(question.requestId)
          const questionRows = rows(question.questions)
          return h('fieldset', { key: requestId, disabled: working }, h('legend', null, text(question.title)),
            ...questionRows.map(item => {
              const id = text(item.id)
              const selected = answers[requestId]?.[id] ?? []
              const set = (value: string[]) => setAnswers(previous => ({ ...previous, [requestId]: { ...previous[requestId], [id]: value } }))
              const choices = rows(item.options)
              return h('div', { key: id }, h('p', null, text(item.question)), ...choices.map(option => {
                const label = text(option.label)
                return h('label', { key: label, style: { display: 'block', margin: '6px 0' } },
                  h('input', { type: item.multiSelect === true ? 'checkbox' : 'radio', name: `${requestId}:${id}`, checked: selected.includes(label), onChange: () => set(item.multiSelect === true ? selected.includes(label) ? selected.filter(value => value !== label) : [...selected, label] : [label]) }),
                  ` ${label}${option.description ? ` — ${text(option.description)}` : ''}`)
              }), choices.length ? null : field(t('回答', 'Answer'), selected[0] ?? '', value => set(value ? [value] : []), true))
            }), button(t('提交回答', 'Submit answer'), () => { void run('question.answer', { requestId, answers: answers[requestId] ?? {} }) }, working || !questionRows.length || questionRows.some(item => !answers[requestId]?.[text(item.id)]?.length)))
        })) : null,
        has('launch.options') ? section(t('账号配置与执行位置', 'Account profile and execution location'),
          button(t('读取启动选项', 'Read launch options'), () => { void run('launch.options', {}, true) }, working),
          launch.canSelect === true && has('launch.select') ? h('div', null,
            select(t('账号配置', 'Account profile'), profile || text(launch.selectedProfileId), rows(launch.profiles), setProfile),
            select(t('执行位置', 'Execution location'), location || text(launch.selectedLocationId), rows(launch.locations), setLocation),
            button(t('保存启动选择', 'Save launch selection'), () => { void run('launch.select', { profileId: profile || text(launch.selectedProfileId), locationId: location || text(launch.selectedLocationId) }) }, busy || (!profile && !location) || !(profile || text(launch.selectedProfileId)) || !(location || text(launch.selectedLocationId)))) :
            h('p', null, t('已有会话保持原账号和执行位置；仅支持的新会话可选择。', 'Existing sessions keep their account and execution location. Selection is available only for supported new sessions.'))) : null,
      ))
  }
  return Management
}
