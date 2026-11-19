import { randomUUID } from 'node:crypto'
import type { ManagedAgentRegistry } from './registry.js'
import type { ManagedAgentConnection, ManagedAgentEmit, ManagedAgentOpen } from './types.js'

export type ManagedRuntimeStatus = {
  state: 'absent' | 'starting' | 'ready' | 'closing' | 'blocked'
  /** In-process ownership fence, not evidence that an OS process is alive. */
  generation?: string
  ownerId: string
  lastActivityAt?: number
  idleObservedAt?: number
  reason?: string
}
type Route = {
  input: ManagedAgentOpen
  generation: string
  state: Exclude<ManagedRuntimeStatus['state'], 'absent'>
  acquisition: Promise<ManagedAgentConnection>
  opening: Promise<ManagedAgentConnection>
  raw?: ManagedAgentConnection
  connection?: ManagedAgentConnection
  closing?: Promise<void>
  revision: number
  lastActivityAt: number
  idleObservedAt?: number
  reason?: string
}

/** One runtime owns a route until its provider close resolves. Viewer lifetimes
 * do not affect it. A failed/uncertain close keeps its fence and blocks reopen.
 * This is not a persistent OS-process lease: adapters must supply exit evidence
 * before cross-process startup recovery can be implemented safely. */
export class ManagedAgentRuntime {
  private readonly routes = new Map<string, Route>()
  private readonly ownerId = randomUUID()
  private closed = false
  private readonly now: () => number
  private readonly closeTimeoutMs: number

  constructor(readonly registry: ManagedAgentRegistry, options: { now?: () => number; closeTimeoutMs?: number } = {}) {
    this.now = options.now ?? Date.now
    this.closeTimeoutMs = Math.max(1, options.closeTimeoutMs ?? 10_000)
  }

  status(sessionId: string): ManagedRuntimeStatus {
    const route = this.routes.get(sessionId)
    return route ? { state: route.state, generation: route.generation, ownerId: this.ownerId,
      lastActivityAt: route.lastActivityAt, ...(route.idleObservedAt === undefined ? {} : { idleObservedAt: route.idleObservedAt }),
      ...(route.reason ? { reason: route.reason } : {}) } : { state: 'absent', ownerId: this.ownerId }
  }
  private touch(route: Route): void { route.revision++; route.lastActivityAt = this.now(); route.idleObservedAt = undefined }
  private current(route: Route): boolean { return this.routes.get(route.input.sessionId) === route }
  private assertReady(route: Route): void {
    if (!this.current(route) || route.state !== 'ready' || this.closed) throw new Error('Managed session ownership is retired or blocked.')
  }
  private guarded(route: Route, connection: ManagedAgentConnection): ManagedAgentConnection {
    // Preserve provider getters (models/options may change while the child runs).
    const methods = new Set(['send', 'steer', 'approve', 'cancel', 'manage', 'setOption', 'models'])
    return new Proxy(connection, { get: (target, key) => {
      if (key === 'close') return () => this.current(route) ? this.close(route.input.sessionId) : Promise.reject(new Error('Managed session ownership is retired.'))
      const value = Reflect.get(target, key, target)
      if (typeof key === 'string' && methods.has(key) && typeof value === 'function') return async (...args: unknown[]) => {
        this.assertReady(route); this.touch(route)
        try { return await value.apply(target, args) }
        finally { if (this.current(route)) this.touch(route) }
      }
      return typeof value === 'function' ? value.bind(target) : value
    } })
  }

  open(input: ManagedAgentOpen, emit: ManagedAgentEmit): Promise<ManagedAgentConnection> {
    if (this.closed) return Promise.reject(new Error('Managed agent runtime is closed.'))
    const prior = this.routes.get(input.sessionId)
    if (prior) {
      if (prior.input.agent !== input.agent || prior.input.workspacePath !== input.workspacePath ||
          (input.providerSessionId && prior.raw && input.providerSessionId !== prior.raw.providerSessionId)) {
        return Promise.reject(new Error('Managed session ownership does not match.'))
      }
      if (prior.state === 'blocked') return Promise.reject(new Error('Managed session process ownership is blocked; cleanup must be confirmed before reopening.'))
      if (prior.state === 'closing') return prior.closing!.then(() => this.open(input, emit))
      return prior.opening
    }
    const registration = this.registry.registration(input.agent)
    if (!registration) return Promise.reject(new Error(`Unsupported managed agent: ${input.agent}`))
    const route: Route = { input: { ...input }, generation: randomUUID(), state: 'starting', revision: 0, lastActivityAt: this.now(),
      acquisition: undefined as unknown as Promise<ManagedAgentConnection>, opening: undefined as unknown as Promise<ManagedAgentConnection> }
    this.routes.set(input.sessionId, route)
    route.acquisition = Promise.resolve().then(() => registration.adapter.open(input, event => {
      if (!this.current(route) || route.state === 'closing' || route.state === 'blocked') return
      this.touch(route)
      if (event.type === 'unavailable') {
        // Never release ownership before cleanup has confirmed completion.
        void this.close(input.sessionId).catch(() => undefined)
      }
      emit(event)
    })).then(connection => { route.raw = connection; return connection })
    route.opening = route.acquisition.then(async connection => {
      if (this.closed || !this.current(route) || route.state !== 'starting') {
        if (this.current(route)) await this.close(input.sessionId)
        throw new Error('Managed session closed during startup.')
      }
      route.state = 'ready'
      route.connection = this.guarded(route, connection)
      return route.connection
    }).catch(error => {
      // An adapter rejection does not currently carry proof that no child was
      // spawned (or that cleanup succeeded). Preserve the fence conservatively.
      if (this.current(route) && route.state !== 'closing') { route.state = 'blocked'; route.reason = 'startup-outcome-unknown' }
      throw error
    })
    return route.opening
  }

  async connection(sessionId: string): Promise<ManagedAgentConnection> {
    const route = this.routes.get(sessionId)
    if (!route) throw new Error('Managed session is not open.')
    if (route.state === 'blocked' || route.state === 'closing') throw new Error('Managed session process ownership is blocked or closing.')
    return route.opening
  }

  async close(sessionId: string): Promise<void> {
    const route = this.routes.get(sessionId)
    if (!route) return
    if (route.closing) return route.closing
    route.state = 'closing'; this.touch(route)
    // A late successful cleanup is valid evidence even after our bounded wait
    // expired. A failure or a hung close never permits acquiring another child.
    const cleanup = (async () => {
      const connection = route.raw ?? await route.acquisition
      await connection.close()
      if (this.current(route)) this.routes.delete(sessionId)
    })()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Managed provider cleanup deadline exceeded.')), this.closeTimeoutMs) })
    route.closing = Promise.race([cleanup, deadline]).catch(error => {
      if (this.current(route)) { route.state = 'blocked'; route.reason = 'cleanup-unconfirmed' }
      throw error
    }).finally(() => { if (timer) clearTimeout(timer); route.closing = undefined })
    return route.closing
  }

  /** Host maintenance only. No timer and no viewer-count based disposal here.
   * A fresh provider answer plus unchanged route activity is required. */
  async cleanupIdle(sessionId: string, idleForMs: number): Promise<boolean> {
    if (!Number.isFinite(idleForMs) || idleForMs < 0) throw new Error('Invalid idle interval.')
    const route = this.routes.get(sessionId)
    if (!route || route.state !== 'ready' || !route.raw?.isIdle || this.now() - route.lastActivityAt < idleForMs) return false
    const revision = route.revision
    let observation: 'idle' | 'busy' | 'unknown'
    try { observation = await route.raw.isIdle() } catch { return false }
    if (observation !== 'idle' || !this.current(route) || route.state !== 'ready' || route.revision !== revision) return false
    route.idleObservedAt = this.now()
    await this.close(sessionId)
    return true
  }

  async closeAll(): Promise<void> {
    this.closed = true
    const results = await Promise.allSettled([...this.routes.keys()].map(id => this.close(id)))
    if (results.some(result => result.status === 'rejected')) throw new Error('Some managed agent processes could not be closed; ownership remains blocked.')
  }
}
