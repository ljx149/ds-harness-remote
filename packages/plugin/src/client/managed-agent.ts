import type { ClientReact } from './types.js'
import { gptWorkspaceIcon, deepSeekWorkspaceIcon } from './icons.js'

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
    const id = managedIds.get(sessionId) ?? 'dsh'
    const src = id === 'codex' ? gptWorkspaceIcon : id === 'claude' || id === 'claude-code' ? claudeIcon : id === 'dsh' ? deepSeekWorkspaceIcon : undefined
    return src ? React.createElement('img', { src, alt: id, title: id, width: 16, height: 16, style: { flexShrink: 0 } }) : React.createElement('span', { title: id, 'aria-label': id }, id.slice(0, 1).toUpperCase())
  }
  function NewSession({ wide }: { wide?: boolean }): unknown {
    useSnapshots()
    const [agents, setAgents] = React.useState<Array<{ id: string; label: string }>>([])
    const [expanded, setExpanded] = React.useState(false)
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState<string | undefined>(undefined)
    const [attempt, setAttempt] = React.useState<{ workspaceId: string; agentId: string; operationId: string } | undefined>(undefined)
    React.useEffect(() => {
      let active = true
      void ctx.call('managedAgent/agents', {}).then(value => {
        const values = Array.isArray(value) ? value : record(value).items
        if (active && Array.isArray(values)) setAgents(values.flatMap(item => {
          const agent = record(item)
          return typeof agent.id === 'string' && agent.available !== false ? [{ id: agent.id, label: typeof agent.name === 'string' ? agent.name : agent.id }] : []
        }))
      }).catch(() => undefined)
      return () => { active = false }
    }, [])
    if (!agents.length) return null
    const current = Object.values(ctx.sessions.list.getSnapshot().byId ?? {}).find(item => (item.retainedBy?.mainView ?? 0) > 0)
    const workspace = ctx.workspaces.list.getSnapshot().items.find(item => current && item.sessionIds?.includes(current.id))
    const create = async (agentId: string): Promise<void> => {
      if (busy || !workspace) return
      const request = attempt?.workspaceId === workspace.workspaceId && attempt.agentId === agentId ? attempt : { workspaceId: workspace.workspaceId, agentId, operationId: crypto.randomUUID() }
      setAttempt(request); setBusy(true); setError(undefined)
      try {
        const result = record(await ctx.call('managedAgent/create', { request }))
        if (typeof result.sessionId !== 'string') throw new Error(ctx.chinese ? '创建会话失败' : 'Session creation failed')
        await ctx.sessions.refresh?.()
        ctx.open(result.sessionId)
        setAttempt(undefined); setExpanded(false)
      } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
      finally { setBusy(false) }
    }
    return React.createElement('div', { className: 'xcodexManagedAgentCreate' },
      React.createElement('button', { className: 'xcodexManagedAgentButton', type: 'button', 'aria-expanded': expanded, disabled: busy || !workspace, title: workspace ? `${ctx.chinese ? '在当前目录新建 Agent 对话' : 'New Agent session in current workspace'}: ${workspace.path ?? workspace.title}` : ctx.chinese ? '请先选择一个工作区中的对话' : 'Select a conversation in a workspace first', onClick: () => setExpanded(value => !value) }, wide === false ? '+' : ctx.chinese ? '+ Agent 对话' : '+ Agent session'),
      expanded ? React.createElement('div', { role: 'group', className: 'xcodexManagedAgentMenu' }, ...agents.map(agent => React.createElement('button', { className: 'xcodexManagedAgentButton', key: agent.id, type: 'button', disabled: busy, onClick: () => { void create(agent.id) } }, agent.label))) : null,
      error ? React.createElement('div', { role: 'alert' }, error) : null)
  }
  return { NewSession, SessionLogo }
}
