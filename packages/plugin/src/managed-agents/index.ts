import { defaultManagedLaunchRegistry, type ManagedLaunchRegistry } from './launch.js'
import { ManagedAcpAdapter } from './acp-adapter.js'
import { ManagedClaudeAdapter } from './claude-adapter.js'
import { ManagedCodexAdapter } from './codex-adapter.js'
import { ManagedAgentRegistry } from './registry.js'
import { ManagedAgentRuntime } from './runtime.js'
import type { AgentSessionCapabilities } from './capabilities.js'

export * from './types.js'
export * from './capabilities.js'
export { ManagedAgentRegistry, ManagedAgentRuntime, ManagedAcpAdapter, ManagedCodexAdapter, ManagedClaudeAdapter }

export function createManagedAgentRuntime(launches: ManagedLaunchRegistry = defaultManagedLaunchRegistry): ManagedAgentRuntime {
  const capabilities: AgentSessionCapabilities = {
    rewind: false, compact: false, threadGoal: false, contextUsage: false,
    imagePrompts: false, steering: 'queue', approvalEnforcement: 'provider',
  }
  return new ManagedAgentRuntime(new ManagedAgentRegistry([
    { definition: { agent: 'codex', title: 'Codex', icon: 'codex', capabilities: { ...capabilities } }, adapter: new ManagedCodexAdapter(undefined, launches) },
    { definition: { agent: 'claude', title: 'Claude Code', icon: 'claude', capabilities: { ...capabilities } }, adapter: new ManagedClaudeAdapter(undefined, 'claude', launches) },
  ]))
}
