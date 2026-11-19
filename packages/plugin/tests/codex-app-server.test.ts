import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import {
  CODEX_THREAD_UNMATERIALIZED,
  CODEX_UNMATERIALIZED_THREAD_MESSAGE,
  CodexAppServerClient,
} from '../src/codex/app-server.js'
import type { SafeLogger } from '../src/logging.js'

describe('CodexAppServerClient', () => {
  it('shares close completion and waits for exit after both termination signals', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeProcess()
      fake.kill.mockImplementation(() => true)
      const client = await startedClient(fake)
      const first = client.close()
      expect(client.close()).toBe(first)
      const completed = vi.fn()
      void first.then(completed)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(fake.kill.mock.calls.map(args => args[0])).toEqual(['SIGTERM', 'SIGKILL'])
      expect(completed).not.toHaveBeenCalled()
      fake.child.emit('exit', null, 'SIGKILL')
      await first
      expect(completed).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('rejects cleanup when a signalled process never exits and retains the same rejected close', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeProcess()
      fake.kill.mockImplementation(() => true)
      Object.defineProperty(fake.child, 'killed', { value: true })
      const client = await startedClient(fake)
      const close = client.close()
      const rejected = expect(close).rejects.toMatchObject({ code: 'CODEX_CLEANUP_UNCONFIRMED' })
      await vi.advanceTimersByTimeAsync(4_000)
      await rejected
      expect(client.close()).toBe(close)
      expect(fake.kill).toHaveBeenCalledWith('SIGKILL')
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('retains the process after communication failure until close confirms process termination', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeProcess()
      fake.kill.mockImplementation(() => true)
      const client = await startedClient(fake)
      fake.child.emit('error', new Error('transport failed'))
      const close = client.close()
      const completed = vi.fn()
      void close.then(completed)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(completed).not.toHaveBeenCalled()
      fake.child.emit('close', 0, null)
      await close
      expect(completed).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('initializes once, correlates responses, and separates inbound events from requests', async () => {
    const fake = fakeProcess()
    const outbound: Array<Record<string, unknown>> = []
    fake.child.stdin.on('data', chunk => {
      for (const line of String(chunk).trim().split('\n')) {
        const message = JSON.parse(line) as Record<string, unknown>
        outbound.push(message)
        if (message.method === 'initialize') {
          fake.stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: 'codex' } })}\n`)
        }
      }
    })
    const client = new CodexAppServerClient('codex-custom', logger(), binary => {
      expect(binary).toBe('codex-custom')
      return fake.child
    })
    const inbound = vi.fn()
    client.onInbound(inbound)

    await client.start()

    expect(outbound.map(message => message.method)).toEqual(['initialize', 'initialized'])
    const pending = client.call('thread/list', {})
    await flush()
    const request = outbound.find(message => message.method === 'thread/list')!
    fake.stdout.write(`${JSON.stringify({ id: 999_999, result: { ignored: true } })}\n`)
    fake.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [] } })}\n`)
    await expect(pending).resolves.toEqual({ data: [] })

    fake.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thr_1' } })}\n`)
    fake.stdout.write(`${JSON.stringify({ id: 'approval-1', method: 'item/fileChange/requestApproval', params: { threadId: 'thr_1' } })}\n`)
    await flush()
    expect(inbound).toHaveBeenNthCalledWith(1, {
      kind: 'notification', method: 'turn/completed', params: { threadId: 'thr_1' },
    })
    expect(inbound).toHaveBeenNthCalledWith(2, {
      kind: 'request', id: 'approval-1', method: 'item/fileChange/requestApproval', params: { threadId: 'thr_1' },
    })

    await client.respond('approval-1', { decision: 'decline' })
    expect(outbound.at(-1)).toEqual({ id: 'approval-1', result: { decision: 'decline' } })
    await client.close()
    expect(fake.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('notifies the supervisor once when the child exits unexpectedly', async () => {
    const fake = fakeProcess()
    fake.child.stdin.on('data', chunk => {
      const message = JSON.parse(String(chunk).trim()) as Record<string, unknown>
      if (message.method === 'initialize') {
        fake.stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: 'codex' } })}\n`)
      }
    })
    const client = new CodexAppServerClient('codex', logger(), () => fake.child)
    const unavailable = vi.fn()
    client.onUnavailable(unavailable)
    await client.start()

    fake.child.emit('exit', 9, null)
    fake.child.emit('exit', 9, null)
    await flush()

    expect(client.isReady()).toBe(false)
    expect(unavailable).toHaveBeenCalledOnce()
    expect(unavailable).toHaveBeenCalledWith('CODEX_APP_SERVER_EXITED')
    await client.close()
  })

  it('keeps active-writer upstream errors specific without exposing the thread id', async () => {
    const fake = fakeProcess()
    const outbound: Array<Record<string, unknown>> = []
    fake.child.stdin.on('data', chunk => {
      for (const line of String(chunk).trim().split('\n')) {
        const message = JSON.parse(line) as Record<string, unknown>
        outbound.push(message)
        if (message.method === 'initialize') {
          fake.stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: 'codex' } })}\n`)
        } else if (message.method === 'turn/start') {
          fake.stdout.write(`${JSON.stringify({
            id: message.id,
            error: { code: -32600, message: 'thread 01a05bd0-8d55-7e23-bc95-97fec98aa8f4 already has an active writer' },
          })}\n`)
        }
      }
    })
    const client = new CodexAppServerClient('codex', logger(), () => fake.child)
    await client.start()

    await expect(client.call('turn/start', { threadId: 'redacted' }))
      .rejects.toMatchObject({ message: 'Codex thread already has an active writer.' })
    await client.close()
  })

  it('keeps an unmaterialized new Thread in a dedicated empty-history error code', async () => {
    const fake = fakeProcess()
    fake.child.stdin.on('data', chunk => {
      for (const line of String(chunk).trim().split('\n')) {
        const message = JSON.parse(line) as Record<string, unknown>
        if (message.method === 'initialize') {
          fake.stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: 'codex' } })}\n`)
        } else if (message.method === 'thread/turns/list') {
          fake.stdout.write(`${JSON.stringify({
            id: message.id,
            error: {
              code: -32600,
              message: 'thread 01a05bd0-8d55-7e23-bc95-97fec98aa8f4 is not materialized yet; thread/turns/list is unavailable before first user message',
            },
          })}\n`)
        }
      }
    })
    const client = new CodexAppServerClient('codex', logger(), () => fake.child)
    await client.start()

    await expect(client.call('thread/turns/list', { threadId: 'redacted' })).rejects.toMatchObject({
      code: CODEX_THREAD_UNMATERIALIZED,
      message: CODEX_UNMATERIALIZED_THREAD_MESSAGE,
    })
    await client.close()
  })
})

function fakeProcess(): { child: ChildProcessWithoutNullStreams; stdout: PassThrough; kill: ReturnType<typeof vi.fn> } {
  const emitter = new EventEmitter()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const state = { killed: false, exitCode: null as number | null }
  const kill = vi.fn((signal?: NodeJS.Signals | number) => {
    state.killed = true
    queueMicrotask(() => emitter.emit('exit', 0, typeof signal === 'string' ? signal : null))
    return true
  })
  const child = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    pid: 123,
    kill,
    get killed() { return state.killed },
    get exitCode() { return state.exitCode },
  }) as unknown as ChildProcessWithoutNullStreams
  return { child, stdout, kill }
}

function logger(): SafeLogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as SafeLogger
}

async function flush(): Promise<void> { await new Promise(resolve => setTimeout(resolve, 0)) }

async function startedClient(fake: ReturnType<typeof fakeProcess>): Promise<CodexAppServerClient> {
  fake.child.stdin.on('data', chunk => {
    for (const line of String(chunk).trim().split('\n')) {
      const message = JSON.parse(line) as Record<string, unknown>
      if (message.method === 'initialize') fake.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`)
    }
  })
  const client = new CodexAppServerClient('codex', logger(), () => fake.child)
  await client.start()
  return client
}
