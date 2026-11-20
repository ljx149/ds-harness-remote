/** Session-scoped facade for DSH's native model dropdown and /model command.
 * Global DSH catalogs cannot represent workspace/profile-specific Agent config. */
type Selection = { provider: string; model: string; reasoningEffort?: string }
type Group = { id: string; name: string; models: Array<{ id: string; name: string; reasoning?: { efforts: Array<{ id: string; name: string }>; defaultEffort?: string } }> }
type State = { current: Selection | null; routable: boolean | null; groups: Group[]; failures: Array<{ id: string; name: string; message: string }>; status: string; pending: Selection | null; error: string | null }
interface Observable { getSnapshot(): unknown; subscribe(callback: () => void): () => void }
interface Binding { session: { projections: { faceOf(key: string): Observable } } }
interface Scope { effect(effect: () => (() => void), label: string): void }
export interface ManagedModelServices {
  resolver: { directoryFor(sessionId: string): unknown }
  sessions: { binding(sessionId: string): Binding | undefined; scope(sessionId: string): Scope | undefined }
  call(endpoint: string, payload: Record<string, unknown>): Promise<unknown>
  subscribeReset?(listener: () => void): () => void
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}
export class ManagedModelDirectory {
  private state: State = { current: null, routable: null, groups: [], failures: [], status: 'idle', pending: null, error: null }
  private listeners = new Set<() => void>()
  private flight?: Promise<State>
  private generation = 0
  private disposed = false
  private unsubscribe: () => void
  readonly store = { getSnapshot: (): State => this.state, subscribe: (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } } }
  constructor(private readonly sessionId: string, private readonly agentId: string, private readonly call: ManagedModelServices['call'], private readonly projection: Observable) {
    this.unsubscribe = projection.subscribe(() => this.sync())
    this.sync()
  }
  private publish(patch: Partial<State>) { if (!this.disposed) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener() } }
  private sync() {
    const next = record(this.projection.getSnapshot()).next as Selection | null | undefined
    const current = next ?? this.state.current
    this.publish({ current, routable: current === null || this.state.status === 'idle' || this.state.status === 'loading' ? null : this.state.groups.some(group => group.id === current.provider && group.models.some(model => model.id === current.model)) })
  }
  load(): Promise<State> {
    if (this.flight) return this.flight
    const generation = this.generation
    this.publish({ status: 'loading', error: null })
    const flight = this.call('managedAgent.models', { sessionId: this.sessionId }).then(value => {
      if (this.disposed || generation !== this.generation) return this.state
      const catalog = value as { groups: Group[]; current?: Selection }
      this.publish({ groups: catalog.groups.filter(group => group.id === this.agentId), current: catalog.current ?? null, failures: [], status: 'ready' })
      this.sync()
      return this.state
    }).catch(error => {
      if (generation === this.generation) this.publish({ status: 'error', error: error instanceof Error ? error.message : String(error) })
      throw error
    }).finally(() => { if (this.flight === flight) this.flight = undefined })
    this.flight = flight
    return flight
  }
  async select(selection: Selection) {
    const generation = this.generation
    this.publish({ status: 'selecting', pending: selection, error: null })
    try {
      await this.call('managedAgent.selectModel', { sessionId: this.sessionId, ...selection })
      if (generation === this.generation) this.publish({ current: selection, pending: null, status: 'ready', routable: true })
      return { ok: true, value: undefined }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (generation === this.generation) this.publish({ pending: null, status: 'error', error: message })
      return { ok: false, error: { code: 'managed-agent/model-selection', message } }
    }
  }
  resetConnected() { ++this.generation; this.flight = undefined; this.publish({ current: null, groups: [], failures: [], pending: null, status: 'idle', error: null, routable: null }) }
  dispose() { this.disposed = true; ++this.generation; this.unsubscribe(); this.listeners.clear() }
}
export function installManagedModelDirectories({ resolver, sessions, call, subscribeReset }: ManagedModelServices): () => void {
  const original = resolver.directoryFor
  const live = new Set<ManagedModelDirectory>()
  const byBinding = new WeakMap<Binding, ManagedModelDirectory>()
  const wrapped = function (sessionId: string): unknown {
    const binding = sessions.binding(sessionId)
    const identity = record(binding?.session.projections.faceOf('managedAgent').getSnapshot())
    if (!binding || typeof identity.agentId !== 'string') return original.call(resolver, sessionId)
    let directory = byBinding.get(binding)
    if (!directory) {
      directory = new ManagedModelDirectory(sessionId, identity.agentId, call, binding.session.projections.faceOf('modelSelection'))
      byBinding.set(binding, directory); live.add(directory)
      const owned = directory
      sessions.scope(sessionId)?.effect(() => () => { owned.dispose(); live.delete(owned); byBinding.delete(binding) }, 'xagent: scoped model directory')
    }
    return directory
  }
  resolver.directoryFor = wrapped
  const unsubscribeReset = subscribeReset?.(() => { for (const directory of live) directory.resetConnected() })
  return () => { unsubscribeReset?.(); if (resolver.directoryFor === wrapped) resolver.directoryFor = original; for (const directory of live) directory.dispose(); live.clear() }
}
