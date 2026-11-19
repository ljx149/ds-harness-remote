import type { ManagedManagementSurface, ManagedPromptImage } from './management.js'
import type { AgentSessionCapabilities } from './capabilities.js'

export interface ManagedAgentDefinition {
  agent: string
  title: string
  icon: string
  capabilities: AgentSessionCapabilities
}

export interface ManagedAgentOpen {
  sessionId: string
  workspacePath: string
  agent: string
  providerSessionId?: string
  model?: string
  reasoningEffort?: string
  launch?: { profileId?: string; locationId?: string }
  permissionMode?: string
  launchFingerprint?: string
  previousLaunch?: { profileId?: string; locationId?: string }
  restoredChildren?: ReadonlyArray<{ id: string; parentThreadId: string; title: string; status: string; turnId?: string }>
}

export type ManagedAgentEvent =
  | { type: 'text'; text: string; itemId?: string }
  | { type: 'reasoning'; text: string; itemId?: string }
  | { type: 'tool'; itemId: string; name: string; status: 'running' | 'completed'; data: unknown }
  | { type: 'approval'; requestId: string; title: string; choices: string[]; data: unknown }
  | { type: 'turn-started'; turnId: string }
  | { type: 'checkpoint'; checkpointId: string; position: 'before' | 'after' }
  | { type: 'turn-completed'; turnId?: string; status: 'completed' | 'cancelled' | 'failed' }
  | { type: 'error'; code: string; message: string }
  | { type: 'unavailable'; code: string }
  | { type: 'text-delta' | 'reasoning-delta'; itemId: string; text: string }
  | { type: 'question'; requestId: string; title: string; questions: unknown }
  | { type: 'context-usage' | 'account-usage' | 'background-task' | 'thread-goal' | 'compacted' | 'options'; data: unknown }

export type ManagedAgentEmit = (event: ManagedAgentEvent) => void
export type ManagedAgentDispatch =
  | { state: 'accepted'; providerTurnId?: string }
  | { state: 'unknown'; reason: string }
  /** Provider proved no input was delivered; retry requires a new operation ID. */
  | { state: 'rejected'; reason: string }

export interface ManagedAgentConnection extends ManagedManagementSurface {
  providerSessionId: string
  readonly defaultModel?: { model: string; reasoningEffort?: string }
  send(input: { messageId: string; text: string; images?: ManagedPromptImage[] }): Promise<ManagedAgentDispatch>
  cancel(): Promise<void>
  approve(requestId: string, choice: string): Promise<void>
  close(): Promise<void>
  models?(): Promise<unknown>
  setOption?(key: string, value: string): Promise<void>
}

export interface ManagedAgentAdapter {
  open(input: ManagedAgentOpen, emit: ManagedAgentEmit): Promise<ManagedAgentConnection>
  copyConversation?: (...args: never[]) => unknown
  compact?: (...args: never[]) => unknown
  changeThreadGoal?: (...args: never[]) => unknown
  rewind?: (...args: never[]) => unknown
  recoverRewind?: (...args: never[]) => unknown
  forkForRewind?: (...args: never[]) => unknown
}

export interface ManagedAgentRegistration {
  definition: ManagedAgentDefinition
  adapter: ManagedAgentAdapter
}
