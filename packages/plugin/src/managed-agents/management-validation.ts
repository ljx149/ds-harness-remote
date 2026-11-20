import { z } from 'zod'
const id = z.string().min(1).max(512)
const operations = ['queue.run', 'queue.remove', 'question.answer'] as const
const payloads = {
  'queue.run': z.object({}).strict(),
  'queue.remove': z.object({ requestId: id }).strict(),
  'question.answer': z.object({ requestId: id, answers: z.record(z.string().min(1).max(512), z.array(z.string().max(16384)).max(64)) }).strict(),
}
/** Public bridge operations; provider-internal management is not a remote API. */
export const managementRequest = z.object({ sessionId: id, operation: z.enum(operations), operationId: id.optional(), payload: z.record(z.string(), z.unknown()).default({}) }).strict()
export function managementPayload(operation: typeof operations[number], payload: unknown): Record<string, unknown> {
  return payloads[operation].parse(payload)
}
