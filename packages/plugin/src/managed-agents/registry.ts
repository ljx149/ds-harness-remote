// Adapted from Orca; Copyright (c) 2026 Lovecast Inc. MIT; see ORCA-LICENSE.
import type { AgentSessionCapabilities } from './capabilities.js'
import type { ManagedAgentAdapter, ManagedAgentDefinition, ManagedAgentRegistration } from './types.js'

type AdapterMethod = keyof ManagedAgentAdapter

/** Rewind may use provider recovery or a fork on next launch. */
function requiredAdapterMethods(
  capabilities: AgentSessionCapabilities,
  adapter: ManagedAgentAdapter
): AdapterMethod[] {
  return [
    ...(capabilities.fork ? (['copyConversation'] as const) : []),
    ...(capabilities.compact ? (['compact'] as const) : []),
    ...(capabilities.threadGoal ? (['changeThreadGoal'] as const) : []),
    ...(capabilities.rewind && !adapter.forkForRewind ? (['rewind', 'recoverRewind'] as const) : [])
  ]
}

export class ManagedAgentRegistry {
  private readonly byAgent: ReadonlyMap<string, ManagedAgentRegistration>

  constructor(registrations: readonly ManagedAgentRegistration[]) {
    const byAgent = new Map<string, ManagedAgentRegistration>()
    for (const registration of registrations) {
      const { agent, capabilities } = registration.definition
      if (byAgent.has(agent)) {
        throw new Error(`structured agent ${agent} is registered twice`)
      }
      const missing = requiredAdapterMethods(capabilities, registration.adapter).find(
        (method) => !registration.adapter[method]
      )
      if (missing) {
        throw new Error(
          `structured agent ${agent} declares a capability its adapter has no ${missing} for`
        )
      }
      byAgent.set(agent, registration)
    }
    this.byAgent = byAgent
  }

  registration(agent: string): ManagedAgentRegistration | null {
    return this.byAgent.get(agent) ?? null
  }

  registrations(): readonly ManagedAgentRegistration[] {
    return [...this.byAgent.values()]
  }

  definition(agent: string): ManagedAgentDefinition | null {
    return this.byAgent.get(agent)?.definition ?? null
  }

  definitions(): readonly ManagedAgentDefinition[] {
    return this.registrations().map((registration) => registration.definition)
  }

  /** Live sessions may narrow declared capabilities, never widen them. */
  capabilities(agent: string): AgentSessionCapabilities | null {
    return this.definition(agent)?.capabilities ?? null
  }
}
