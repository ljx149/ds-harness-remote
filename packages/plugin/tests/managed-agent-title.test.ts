import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { generateManagedTitle, parseManagedTitle, titleCommand } from '../src/managed-agents/title.js'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
const input = () => ({ agent: 'claude', cwd: '/project', text: '修复登录问题', model: 'configured-model', signal: new AbortController().signal })
function child() {
  const process = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn() })
  vi.mocked(spawn).mockReturnValue(process as any)
  return process
}
describe('managed model title generation', () => {
  it('uses a separate ephemeral command and the configured model', () => {
    expect(titleCommand(input()).args).toEqual(expect.arrayContaining(['--no-session-persistence', '--tools', '', '--strict-mcp-config', '--model', 'configured-model']))
    expect(titleCommand({ ...input(), agent: 'codex' }).args).toEqual(expect.arrayContaining(['--ephemeral', '--sandbox', 'read-only', '--json', '--model', 'configured-model']))
    expect(() => titleCommand({ ...input(), agent: 'unsupported' })).toThrow()
  })
  it('extracts only the final agent title from Codex JSONL, not reasoning or tool output', () => {
    const output = [JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'not the title' } }), JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '登录凭证刷新修复' } })].join('\n')
    expect(parseManagedTitle('codex', output)).toBe('登录凭证刷新修复')
    expect(() => parseManagedTitle('codex', '{}')).toThrow()
  })
  it('delivers prompt via stdin and returns a normalized title', async () => {
    const proc = child(), result = generateManagedTitle(input())
    expect(spawn).toHaveBeenCalledWith('claude', expect.not.arrayContaining(['修复登录问题']), expect.objectContaining({ cwd: '/project' }))
    proc.stdout.write('"登录问题修复"\n')
    proc.emit('close', 0)
    expect(await result).toBe('登录问题修复')
  })
  it('kills timed out requests and rejects without disclosing stderr', async () => {
    vi.useFakeTimers()
    const proc = child(), result = generateManagedTitle(input())
    const failure = expect(result).rejects.toThrow('MANAGED_TITLE_FAILED')
    vi.advanceTimersByTime(45_000)
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
    proc.emit('close', null)
    await failure
  })
  it('aborts its child on Host shutdown', async () => {
    const controller = new AbortController(), proc = child()
    const result = generateManagedTitle({ ...input(), signal: controller.signal })
    const failure = expect(result).rejects.toThrow('MANAGED_TITLE_FAILED')
    controller.abort()
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
    proc.emit('close', null)
    await failure
  })
})
