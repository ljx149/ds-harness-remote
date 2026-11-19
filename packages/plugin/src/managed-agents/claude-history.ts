// Profile-isolated SDK transcript operations. No global environment mutation.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ClaudeHistoryAccess } from './claude-adapter.js'
import type { ManagedLaunchPlan } from './launch.js'

/** Resolve from installed plugin/Host code, never from an untrusted workspace's
 * node_modules. Bundle-only installations may not carry this external module:
 * then profile history controls stay unavailable instead of using another home. */
export function resolveClaudeHistorySdk(): string | undefined {
  // The release carries an isolated SDK export alongside the Host bundle, so
  // custom-profile helpers work in dependency-free GitHub installations too.
  const bundled = new URL('./claude-history-sdk.js', import.meta.url)
  if (existsSync(bundled)) return bundled.href
  const anchors = [import.meta.url, ...(process.argv[1] && isAbsolute(process.argv[1]) ? [pathToFileURL(process.argv[1]).href] : [])]
  for (const anchor of anchors) {
    try { return pathToFileURL(createRequire(anchor).resolve('@anthropic-ai/claude-agent-sdk')).href } catch { /* next trusted anchor */ }
  }
  return undefined
}
export const CLAUDE_HISTORY_HELPER = `
// Independent bound also applies if the parent disappears while SDK I/O hangs.
const watchdog = setTimeout(() => process.exit(3), 32000);
watchdog.unref();
let source = '';
for await (const part of process.stdin) { source += part; if (source.length > 65536) process.exit(2); }
try {
  const input = JSON.parse(source);
  const sdk = await import(input.module);
  if (input.operation === 'messages') {
    const messages = await sdk.getSessionMessages(input.sessionId, { dir: input.dir, limit: 10000 });
    const safe = messages.map(message => ({ uuid: message.uuid, session_id: message.session_id, parent_tool_use_id: message.parent_tool_use_id, type: message.type, message: { stop_reason: message.message?.stop_reason } }));
    process.stdout.write(JSON.stringify({ messages: safe }));
  } else if (input.operation === 'fork') {
    const fork = await sdk.forkSession(input.sessionId, { dir: input.dir, ...(input.checkpointId ? { upToMessageId: input.checkpointId } : {}), ...(input.title ? { title: input.title } : {}) });
    process.stdout.write(JSON.stringify({ sessionId: fork.sessionId }));
  } else process.exitCode = 2;
} catch { process.exitCode = 1; }
`
export type ClaudeHistorySpawn = typeof spawn
/** Helper stdout contains only checkpoint metadata/new identity, never message
 * bodies, tokens or settings. stderr is drained but never surfaced or logged. */
export function runClaudeHistoryHelper(module: string, environment: NodeJS.ProcessEnv, input: Record<string, unknown>, spawnHelper: ClaudeHistorySpawn = spawn, timeoutMs = 30_000): Promise<unknown> {
  let payload: string
  try { payload = JSON.stringify({ ...input, module }) } catch { return Promise.reject(new Error('Invalid Claude profile history request.')) }
  if (Buffer.byteLength(payload, 'utf8') > 65536) return Promise.reject(new Error('Claude profile history request exceeded its bound.'))
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams
    try { child = spawnHelper(process.execPath, ['--input-type=module', '-e', CLAUDE_HISTORY_HELPER], { env: environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false }) as ChildProcessWithoutNullStreams }
    catch { reject(new Error('Claude profile history helper could not start.')); return }
    let ended = false
    let failure: Error | undefined
    let shutdownTimer: ReturnType<typeof setTimeout> | undefined
    let output = ''
    const settle = (error?: Error, value?: unknown) => {
      if (ended) return
      ended = true; clearTimeout(timer); clearTimeout(shutdownTimer)
      if (error) reject(error); else resolve(value)
    }
    const stop = (error: Error) => {
      if (ended || failure) return
      failure = error; clearTimeout(timer)
      // kill() returning true only means signal delivery, not process death.
      // Wait for close; never report a timed-out mutation as safe to retry.
      shutdownTimer = setTimeout(() => settle(new Error('Claude profile history outcome and helper exit are unproven; do not retry automatically.')), 2000)
      shutdownTimer.unref?.()
      try { child.kill('SIGKILL') } catch { /* close or bounded unproven outcome */ }
    }
    const timer = setTimeout(() => stop(new Error('Claude profile history outcome is unknown; do not retry automatically.')), timeoutMs)
    timer.unref?.()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      if (ended || failure) return
      output += String(chunk)
      if (Buffer.byteLength(output, 'utf8') > 2 * 1024 * 1024) { output = ''; stop(new Error('Claude profile history output exceeded its bound.')) }
    })
    child.stderr.resume()
    child.on('error', () => stop(new Error('Claude profile history helper failed.')))
    child.stdin.on('error', () => stop(new Error('Claude profile history delivery outcome is unknown.')))
    child.on('close', code => {
      if (failure) { settle(failure); return }
      if (code !== 0) { settle(new Error('Claude profile history operation failed.')); return }
      try { settle(undefined, JSON.parse(output)) } catch { settle(new Error('Claude profile history result is invalid.')) }
    })
    try { child.stdin.end(payload) } catch { stop(new Error('Claude profile history delivery outcome is unknown.')) }
  })
}
export function createScopedClaudeHistory(plan: ManagedLaunchPlan, module = resolveClaudeHistorySdk()): ClaudeHistoryAccess | undefined {
  if (plan.kind !== 'native' || !module) return undefined
  const environment = plan.environment()
  return {
    messages: async (sessionId, dir) => {
      const result = await runClaudeHistoryHelper(module, environment, { operation: 'messages', sessionId, dir }) as { messages?: unknown }
      if (!Array.isArray(result.messages)) throw new Error('Claude profile checkpoint result is invalid.')
      return result.messages as Awaited<ReturnType<ClaudeHistoryAccess['messages']>>
    },
    fork: async (sessionId, dir, checkpointId, title) => {
      const result = await runClaudeHistoryHelper(module, environment, { operation: 'fork', sessionId, dir, checkpointId, title }) as { sessionId?: unknown }
      if (typeof result.sessionId !== 'string' || !/^[a-f0-9-]{36}$/i.test(result.sessionId)) throw new Error('Claude profile fork result is invalid.')
      return result.sessionId
    },
  }
}
