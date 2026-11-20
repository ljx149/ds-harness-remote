import { z } from 'zod'
export const questionsSchema = z.array(z.object({
  id: z.string().min(1).max(512), question: z.string().min(1).max(16384),
  header: z.string().max(512).optional(), isSecret: z.boolean().optional(), multiSelect: z.boolean().optional(),
  options: z.array(z.object({ label: z.string().min(1).max(1024), description: z.string().max(4096).optional() })).max(64).optional(),
})).min(1).max(32).refine(items => new Set(items.map(item => item.id)).size === items.length, 'Duplicate question id')
export type ManagedQuestion = z.infer<typeof questionsSchema>[number]
export const answersSchema = z.record(z.string().min(1).max(512), z.array(z.string().max(16384)).max(64))
export function validateAnswers(questions: ManagedQuestion[], value: unknown): Record<string, string[]> {
  const answers = answersSchema.parse(value)
  if (Object.keys(answers).length !== questions.length || questions.some(question => !answers[question.id]?.length || (!question.multiSelect && answers[question.id]!.length !== 1))) throw new Error('MANAGED_QUESTION_ANSWERS_INVALID')
  return answers
}
