import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { runClaudeHistoryHelper, type ClaudeHistorySpawn } from '../src/managed-agents/claude-history.js'

function helper(reply: string, code = 0) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) })
  let input = ''
  child.stdin.setEncoding('utf8')
  child.stdin.on('data', chunk => { input += chunk })
  child.stdin.on('finish', () => {
    child.stderr.write('provider token must never reach error logs')
    child.stdout.write(reply)
    child.emit('close', code)
  })
  const spawn = vi.fn(() => child) as unknown as ClaudeHistorySpawn
  return { child, spawn, input: () => input }
}

describe('profile isolated Claude history helper', () => {
  it('uses child-only environment and stdin, never interpolates an input into argv', async () => {
    const h = helper('{"sessionId":"12345678-1234-1234-1234-123456789abc"}')
    const baseline = process.env.CLAUDE_CONFIG_DIR
    const env = { CLAUDE_CONFIG_DIR: '/private/profile', ANTHROPIC_API_KEY: 'private-value' }
    expect(await runClaudeHistoryHelper('file:///trusted/sdk.mjs', env, { operation: 'fork', title: '$(not executed)', sessionId: 'owned', dir: '/work' }, h.spawn)).toEqual({ sessionId: '12345678-1234-1234-1234-123456789abc' })
    const args = vi.mocked(h.spawn).mock.calls[0]!
    expect(JSON.stringify(args[1])).not.toContain('private-value')
    expect(JSON.stringify(args[1])).not.toContain('$(not executed)')
    expect(args[2]).toMatchObject({ env, shell: false })
    expect(JSON.parse(h.input())).toMatchObject({ module: 'file:///trusted/sdk.mjs', title: '$(not executed)' })
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(baseline)
  })

  it('sanitizes child failures instead of forwarding stderr', async () => {
    const h = helper('', 1)
    await expect(runClaudeHistoryHelper('file:///trusted/sdk.mjs', {}, { operation: 'fork' }, h.spawn)).rejects.toThrow('Claude profile history operation failed.')
  })

  it('rejects output beyond the metadata bound and terminates only its own helper', async () => {
    const h = helper('x'.repeat(2 * 1024 * 1024 + 1))
    await expect(runClaudeHistoryHelper('file:///trusted/sdk.mjs', {}, { operation: 'messages' }, h.spawn)).rejects.toThrow('exceeded its bound')
    expect(h.child.kill).toHaveBeenCalledWith('SIGKILL')
  })
  it('rejects invalid or oversized input before spawning a helper', async () => {
    const h = helper('{}')
    const circular: Record<string, unknown> = {}; circular.self = circular
    await expect(runClaudeHistoryHelper('file:///trusted/sdk.mjs', {}, circular, h.spawn)).rejects.toThrow('Invalid')
    await expect(runClaudeHistoryHelper('file:///trusted/sdk.mjs', {}, { title: 'x'.repeat(65536) }, h.spawn)).rejects.toThrow('request exceeded')
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('waits for helper close after timeout and distinguishes unproven termination', async () => {
    vi.useFakeTimers()
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => false) })
    const spawn = vi.fn(() => child) as unknown as ClaudeHistorySpawn
    try {
      const result = runClaudeHistoryHelper('file:///trusted/sdk.mjs', {}, {}, spawn, 10)
      const rejected = expect(result).rejects.toThrow('helper exit are unproven')
      await vi.advanceTimersByTimeAsync(10)
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
      await vi.advanceTimersByTimeAsync(2000)
      await rejected
    } finally { vi.useRealTimers() }
  })

})
