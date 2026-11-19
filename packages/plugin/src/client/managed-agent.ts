import type { ClientReact } from './types.js'
import { gptWorkspaceIcon } from './icons.js'

interface Snapshot<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
interface SessionRow { id: string; retainedBy?: Record<string, number>; agentId?: string; projections?: { values?: Record<string, unknown> } }
interface WorkspaceRow { workspaceId: string; title?: string; path?: string; sessionIds?: readonly string[] }
export interface ManagedAgentUiContext {
  sessions: { list: Snapshot<{ byId?: Record<string, SessionRow> }>; refresh?(): Promise<void> }
  workspaces: { list: Snapshot<{ items: readonly WorkspaceRow[] }> }
  call(endpoint: string, request: Record<string, unknown>): Promise<unknown>
  open(sessionId: string): void
  chinese: boolean
}
const record = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
const claudeIcon = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g stroke="#D97757" stroke-width="2.2"><path d="M12 1v22M1 12h22M4.2 4.2l15.6 15.6M4.2 19.8L19.8 4.2M7.8 1.8l8.4 20.4M1.8 7.8l20.4 8.4M1.8 16.2l20.4-8.4M7.8 22.2l8.4-20.4"/></g></svg>')

export function createManagedAgentUi(React: ClientReact, ctx: ManagedAgentUiContext): {
  NewSession: (props: { wide?: boolean }) => unknown
  SessionLogo: (props: { sessionId: string }) => unknown
} {
  const managedIds = new Map<string, string>()
  let catalogFlight: Promise<void> | undefined
  const catalogListeners = new Set<() => void>()
  const refreshCatalog = (): void => {
    if (catalogFlight) return
    catalogFlight = ctx.call('managedAgent/catalog', {}).then(value => {
      const items = Array.isArray(value) ? value : record(value).items
      if (!Array.isArray(items)) return
      managedIds.clear()
      for (const item of items) {
        const entry = record(item)
        if (typeof entry.sessionId === 'string' && typeof entry.agentId === 'string') managedIds.set(entry.sessionId, entry.agentId)
      }
      for (const listener of catalogListeners) listener()
    }).catch(() => { managedIds.clear(); for (const listener of catalogListeners) listener() }).finally(() => { catalogFlight = undefined })
  }
  function useSnapshots(): void {
    const [, update] = React.useState(0)
    React.useEffect(() => {
      const changed = () => update(value => value + 1)
      const a = ctx.sessions.list.subscribe(() => { changed(); refreshCatalog() })
      catalogListeners.add(changed)
      refreshCatalog()
      const b = ctx.workspaces.list.subscribe(changed)
      return () => { a(); b(); catalogListeners.delete(changed) }
    }, [])
  }
  function SessionLogo({ sessionId }: { sessionId: string }): unknown {
    useSnapshots()
    const session = ctx.sessions.list.getSnapshot().byId?.[sessionId]
    if (!session) return null
    const projected = record(session.projections?.values?.managedAgent).agentId
    const id = typeof projected === 'string' ? projected : managedIds.get(sessionId)
    if (!id || id === 'dsh' || id === 'deepseek') return null
    const src = id === 'codex' ? gptWorkspaceIcon : id === 'claude' || id === 'claude-code' ? claudeIcon : undefined
    return src ? React.createElement('img', { src, alt: id, title: id, width: 16, height: 16, style: { flexShrink: 0 } }) : React.createElement('span', { title: id, 'aria-label': id }, id.slice(0, 1).toUpperCase())
  }
  function NewSession({ wide }: { wide?: boolean }): unknown {
    useSnapshots()
    const [agents, setAgents] = React.useState<Array<{ id: string; label: string }>>([])
    const [expanded, setExpanded] = React.useState(false)
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState<string | undefined>(undefined)
    const [attempt, setAttempt] = React.useState<{ workspaceId: string; agentId: string; operationId: string } | undefined>(undefined)
    const [loading, setLoading] = React.useState(true)
    const [reload, setReload] = React.useState(0)
    const [chosenWorkspace, setChosenWorkspace] = React.useState<string | undefined>(undefined)
    const mounted = React.useRef(false)
    const creating = React.useRef(false)
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
    React.useEffect(() => {
      let active = true
      setLoading(true); setError(undefined); setAgents([])
      void ctx.call('managedAgent/agents', {}).then(value => {
        const values = Array.isArray(value) ? value : record(value).items
        if (!Array.isArray(values)) throw new Error(ctx.chinese ? 'Agent 列表格式错误' : 'Invalid Agent list')
        if (active) setAgents(values.flatMap(item => {
          const agent = record(item)
          return typeof agent.id === 'string' && agent.available !== false ? [{ id: agent.id, label: typeof agent.name === 'string' ? agent.name : agent.id }] : []
        }))
      }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : String(reason)) })
        .finally(() => { if (active) setLoading(false) })
      return () => { active = false }
    }, [reload])
    const current = Object.values(ctx.sessions.list.getSnapshot().byId ?? {}).find(item => (item.retainedBy?.mainView ?? 0) > 0)
    const workspaces = ctx.workspaces.list.getSnapshot().items
    const workspace = chosenWorkspace
      ? workspaces.find(item => item.workspaceId === chosenWorkspace)
      : workspaces.find(item => current && item.sessionIds?.includes(current.id)) ?? (workspaces.length === 1 ? workspaces[0] : undefined)
    const create = async (agentId: string): Promise<void> => {
      if (creating.current || !workspace || !ctx.workspaces.list.getSnapshot().items.some(item => item.workspaceId === workspace.workspaceId)) return
      creating.current = true
      const request = attempt?.workspaceId === workspace.workspaceId && attempt.agentId === agentId ? attempt : { workspaceId: workspace.workspaceId, agentId, operationId: crypto.randomUUID() }
      setAttempt(request); setBusy(true); setError(undefined)
      try {
        const result = record(await ctx.call('managedAgent/create', { request }))
        if (typeof result.sessionId !== 'string') throw new Error(ctx.chinese ? '创建会话失败' : 'Session creation failed')
        await ctx.sessions.refresh?.()
        if (!mounted.current || !ctx.workspaces.list.getSnapshot().items.some(item => item.workspaceId === request.workspaceId)) return
        ctx.open(result.sessionId)
        setAttempt(undefined); setExpanded(false)
      } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
      finally { creating.current = false; if (mounted.current) setBusy(false) }
    }
    return React.createElement('div', { className: 'xcodexManagedAgentCreate' },
      React.createElement('button', { className: 'xcodexManagedAgentButton', type: 'button', 'aria-expanded': expanded, disabled: busy, title: ctx.chinese ? '选择 Agent 并新建对话' : 'Choose an Agent and create a session', onClick: () => setExpanded(value => !value) }, wide === false ? '+' : ctx.chinese ? '+ Agent 对话' : '+ Agent session'),
      expanded ? React.createElement('div', { role: 'group', className: 'xcodexManagedAgentMenu' },
        React.createElement('label', null, ctx.chinese ? '工作区' : 'Workspace',
          React.createElement('select', { 'aria-label': ctx.chinese ? '工作区' : 'Workspace', value: workspace?.workspaceId ?? '', disabled: busy,
            onChange: (event: { target: { value: string } }) => setChosenWorkspace(event.target.value || undefined) },
            React.createElement('option', { value: '' }, ctx.chinese ? '请选择工作区' : 'Choose workspace'),
            ...workspaces.map(item => React.createElement('option', { key: item.workspaceId, value: item.workspaceId }, item.path ?? item.title ?? item.workspaceId)))),
        loading ? React.createElement('div', { role: 'status' }, ctx.chinese ? '正在加载 Agent…' : 'Loading Agents…') : null,
        !loading && !agents.length && !error ? React.createElement('div', null, ctx.chinese ? '没有可用 Agent，请检查插件配置后重试' : 'No Agents available. Check plugin configuration and retry.') : null,
        ...agents.map(agent => React.createElement('button', { className: 'xcodexManagedAgentButton', key: agent.id, type: 'button', disabled: busy || !workspace, onClick: () => { void create(agent.id) } }, agent.label)),
        React.createElement('button', { className: 'xcodexManagedAgentButton', type: 'button', disabled: busy || loading, onClick: () => setReload(value => value + 1) }, ctx.chinese ? '重新加载 Agent' : 'Reload Agents')) : null,
      error ? React.createElement('div', { role: 'alert' }, error) : null)
  }
  return { NewSession, SessionLogo }
}
