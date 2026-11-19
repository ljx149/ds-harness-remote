import { z } from 'zod'
import { managedManagementOperations, type ManagedManagementOperation } from './management.js'

const id = z.string().min(1).max(512)
const empty = z.object({}).strict()
const checkpoint = z.object({ checkpointId: id }).strict()
const server = z.object({ name: id }).strict()
/** Never forward arbitrary thread IDs, workspace paths, credentials or SDK options. */
const payloads: Record<ManagedManagementOperation, z.ZodType> = {
  'queue.run': empty, 'queue.remove': z.object({ requestId: id }).strict(),
  state: empty, context: empty, accountUsage: empty, commands: empty, settings: empty,
  'launch.options': empty, 'launch.open': empty,
  'launch.select': z.object({ profileId: id, locationId: id }).strict(),
  'option.set': z.object({ key: z.enum(['model', 'reasoningEffort', 'permissionMode', 'fastMode']), value: id }).strict(),
  compact: z.object({ instructions: z.string().max(16384).optional() }).strict(),
  rewind: checkpoint,
  fork: z.object({ checkpointId: id.optional() }).strict(),
  rename: z.object({ title: z.string().trim().min(1).max(1024) }).strict(),
  'goal.read': empty,
  'goal.set': z.object({ objective: z.string().trim().min(1).max(16384).optional(), tokenBudget: z.number().int().positive().optional(), status: z.enum(['active', 'paused']).optional() }).strict(),
  'goal.clear': empty,
  'mcp.list': empty, 'mcp.reconnect': server,
  'mcp.toggle': z.object({ name: id, enabled: z.boolean() }).strict(),
  'mcp.authenticate': server,
  'mcp.callback': z.object({ name: id, callbackUrl: z.string().url().max(8192) }).strict(),
  'mcp.reload': empty,
  'tasks.list': empty,
  'tasks.stop': z.object({ taskId: id }).strict(),
  'tasks.background': z.object({ toolUseId: id }).strict(),
  'question.answer': z.object({ requestId: id, answers: z.record(z.string().min(1).max(512), z.array(z.string().max(16384)).max(64)) }).strict(),
}
export const managementRequest = z.object({ sessionId: id, operation: z.enum(managedManagementOperations), operationId: id.optional(), payload: z.record(z.string(), z.unknown()).default({}) }).strict()
export function managementPayload(operation: ManagedManagementOperation, payload: unknown): Record<string, unknown> {
  return payloads[operation].parse(payload) as Record<string, unknown>
}
export const managementReads = new Set<ManagedManagementOperation>(['state', 'context', 'accountUsage', 'commands', 'settings', 'goal.read', 'mcp.list', 'tasks.list', 'launch.options'])
export const managementWhileBusy = new Set<ManagedManagementOperation>([...managementReads, 'question.answer', 'tasks.stop', 'tasks.background', 'mcp.callback', 'goal.clear'])
