import type { ManagedAgentRegistry } from './registry.js'
import type { ManagedAgentConnection, ManagedAgentEmit, ManagedAgentOpen } from './types.js'

type Route = { input: ManagedAgentOpen; opening: Promise<ManagedAgentConnection>; connection?: ManagedAgentConnection }

/** Host-owned execution: subscriptions and device connections never own the child lifetime. */
export class ManagedAgentRuntime {
  private readonly routes = new Map<string, Route>()
  private closed = false

  constructor(readonly registry: ManagedAgentRegistry) {}

  open(input: ManagedAgentOpen, emit: ManagedAgentEmit): Promise<ManagedAgentConnection> {
    if (this.closed) return Promise.reject(new Error('Managed agent runtime is closed.'))
    const prior = this.routes.get(input.sessionId)
    if (prior) {
      if (prior.input.agent !== input.agent || prior.input.workspacePath !== input.workspacePath ||
          (input.providerSessionId && prior.connection && input.providerSessionId !== prior.connection.providerSessionId)) {
        return Promise.reject(new Error('Managed session ownership does not match.'))
      }
      return prior.opening
    }
    const registration = this.registry.registration(input.agent)
    if (!registration) return Promise.reject(new Error(`Unsupported managed agent: ${input.agent}`))
    const route: Route = { input: { ...input }, opening: Promise.resolve().then(async () => {
      const connection = await registration.adapter.open(input, event => {
        // Provider callbacks can race asynchronous close. A retired generation
        // must never mutate the replacement session's busy state or transcript.
        if (this.routes.get(input.sessionId) !== route) return
        if (event.type === 'unavailable' && this.routes.get(input.sessionId) === route) {
          this.routes.delete(input.sessionId)
          void route.connection?.close().catch(() => undefined)
        }
        emit(event)
      })
      if (this.closed || this.routes.get(input.sessionId) !== route) {
        await connection.close()
        throw new Error('Managed session closed during startup.')
      }
      route.connection = connection
      return connection
    }).catch(error => {
      if (this.routes.get(input.sessionId) === route) this.routes.delete(input.sessionId)
      throw error
    }) }
    this.routes.set(input.sessionId, route)
    return route.opening
  }

  async connection(sessionId: string): Promise<ManagedAgentConnection> {
    const route = this.routes.get(sessionId)
    if (!route) throw new Error('Managed session is not open.')
    return route.opening
  }

  async close(sessionId: string): Promise<void> {
    const route = this.routes.get(sessionId)
    if (!route) return
    this.routes.delete(sessionId)
    if (route.connection) await route.connection.close()
    else await route.opening.catch(() => undefined)
  }

  async closeAll(): Promise<void> {
    this.closed = true
    const results = await Promise.allSettled([...this.routes.keys()].map(id => this.close(id)))
    const failed = results.filter(result => result.status === 'rejected')
    if (failed.length) throw new Error('Some managed agent processes could not be closed.')
  }
}
