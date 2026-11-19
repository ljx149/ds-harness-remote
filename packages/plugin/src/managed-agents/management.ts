// Orca management boundary adapted for a Host-owned DSH plugin. MIT; see ORCA-LICENSE.
/** Only implemented controls may appear in a live connection's management list.
 * The backend owns session IDs, authorization and durable mutation receipts. */
export const managedManagementOperations = [
  'queue.run', 'queue.remove', 'state', 'context', 'accountUsage', 'commands', 'settings', 'option.set', 'launch.options', 'launch.select', 'launch.open',
  'compact', 'rewind', 'fork', 'rename', 'goal.read', 'goal.set', 'goal.clear',
  'mcp.list', 'mcp.reconnect', 'mcp.toggle', 'mcp.authenticate', 'mcp.callback', 'mcp.reload',
  'tasks.list', 'tasks.stop', 'tasks.background', 'question.answer',
] as const
export type ManagedManagementOperation = typeof managedManagementOperations[number]
export type ManagedManagementRequest = Record<string, unknown>
export interface ManagedPromptImage { mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string }
export interface ManagedManagementSurface {
  /** This list must reflect this CLI/SDK version, not just the provider name. */
  readonly managementOperations?: readonly ManagedManagementOperation[]
  manage?(operation: ManagedManagementOperation, request: ManagedManagementRequest): Promise<unknown>
  steer?(input: { messageId: string; text: string; images?: ManagedPromptImage[] }): Promise<import('./types.js').ManagedAgentDispatch>
  /** Never infer idle from elapsed time or from a disconnected viewer. */
  isIdle?(): Promise<'idle' | 'busy' | 'unknown'>
}
