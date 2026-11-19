import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { ManagedLaunchRegistry, type ManagedNativeSpawn, type ManagedOwnedTransport } from '../src/managed-agents/launch.js'
import { managedPosixCommand, managedSshArguments, managedWslArguments, quoteManagedPosix } from '../src/managed-agents/launch-command.js'

describe('Host owned Agent launch', () => {
  it('keeps profile credentials out of discovery/serialization and applies the selected native home', () => {
    const spawn = vi.fn<ManagedNativeSpawn>(() => ({}) as ChildProcessWithoutNullStreams)
    const registry = new ManagedLaunchRegistry({ profiles: [{ id: 'work', label: 'Work account', claudeConfigDir: '/private/claude', environment: { ANTHROPIC_API_KEY: 'private-host-value' } }] }, spawn)
    expect(registry.options('claude', '/work')).toEqual({ profiles: [{ id: 'host', label: 'Computer configuration' }, { id: 'work', label: 'Work account' }], locations: [{ id: 'native', label: 'This computer', kind: 'native' }] })
    expect(registry.options('codex', '/work').profiles).toHaveLength(1)
    const plan = registry.resolve({ agent: 'claude', workspacePath: '/work', selection: { profileId: 'work' } })
    expect(JSON.stringify(plan)).not.toContain('private')
    plan.spawn('claude', ['--print', 'a; $(not-executed)'], { env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/wrong', CLAUDE_CODE_OAUTH_TOKEN: 'wrong-owner-token', ANTHROPIC_BASE_URL: 'wrong-owner-url' } })
    expect(spawn).toHaveBeenCalledWith('claude', ['--print', 'a; $(not-executed)'], expect.objectContaining({ cwd: '/work', shell: false, env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/private/claude', ANTHROPIC_API_KEY: 'private-host-value' } }))
  })

  it('refuses missing/changed resume owners without falling back to current account', () => {
    const registry = new ManagedLaunchRegistry({ profiles: [{ id: 'other', label: 'Other', codexHome: '/private/codex' }] })
    expect(() => registry.resolve({ agent: 'codex', workspacePath: '/work', selection: { profileId: 'removed' } })).toThrow('unavailable')
    expect(() => registry.resolve({ agent: 'codex', workspacePath: '/work', selection: { profileId: 'other' }, previous: { profileId: 'host' }, resuming: true })).toThrow('another account')
    const initial = registry.resolve({ agent: 'codex', workspacePath: '/work', selection: { profileId: 'other' } })
    expect(() => registry.resolve({ agent: 'codex', workspacePath: '/work', selection: { profileId: 'other' }, previous: { profileId: 'other' }, resuming: true })).toThrow('ownership binding')
    expect(registry.resolve({ agent: 'codex', workspacePath: '/work', selection: { profileId: 'other' }, previous: { profileId: 'other' }, previousFingerprint: initial.ownerFingerprint, resuming: true }).selection.profileId).toBe('other')
    const edited = new ManagedLaunchRegistry({ profiles: [{ id: 'other', label: 'Other', codexHome: '/different/account' }] })
    expect(() => edited.resolve({ agent: 'codex', workspacePath: '/work', selection: { profileId: 'other' }, previous: { profileId: 'other' }, previousFingerprint: initial.ownerFingerprint, resuming: true })).toThrow('configuration has changed')
  })

  it('does not advertise remote locations without real owned transports and exact workspace mappings', () => {
    const registry = new ManagedLaunchRegistry({ locations: [{ id: 'remote', label: 'Remote', kind: 'ssh', workspaceMap: { '/work': '/remote/work' } }] })
    expect(registry.options('codex', '/work').locations).toHaveLength(1)
    expect(() => registry.resolve({ agent: 'codex', workspacePath: '/work', selection: { locationId: 'remote' } })).toThrow('unavailable')
    const transport: ManagedOwnedTransport = { ownership: 'process-tree', ready: true, spawn: vi.fn(() => ({}) as ChildProcessWithoutNullStreams) }
    registry.registerTransport('remote', transport)
    expect(registry.options('codex', '/unknown').locations).toHaveLength(1)
    expect(registry.options('codex', '/work').locations).toHaveLength(2)
    const plan = registry.resolve({ agent: 'codex', workspacePath: '/work', selection: { locationId: 'remote' } })
    plan.spawn('codex', ['app-server'], { env: { OPENAI_API_KEY: 'never-forward-local-secret' } })
    expect(transport.spawn).toHaveBeenCalledWith({ command: 'codex', args: ['app-server'], cwd: '/remote/work' })
    expect(() => plan.environment()).toThrow('stay on the executor')
  })

  it('passes SDK termination signal to native spawn without replacing its grace path', () => {
    const spawn = vi.fn<ManagedNativeSpawn>(() => ({}) as ChildProcessWithoutNullStreams)
    const plan = new ManagedLaunchRegistry({}, spawn).resolve({ agent: 'claude', workspacePath: '/work' })
    const controller = new AbortController()
    plan.claudeOptions().spawnClaudeCodeProcess!({ command: 'claude', args: [], env: {}, signal: controller.signal })
    expect(spawn).toHaveBeenCalledWith('claude', [], expect.objectContaining({ signal: controller.signal, cwd: '/work' }))
    controller.abort()
    expect(() => plan.spawn('claude', [], { signal: controller.signal })).toThrow('cancelled')
  })

  it('quotes POSIX bytes, separates SSH options and uses WSL --exec without cmd.exe', () => {
    expect(quoteManagedPosix("a'b $(touch /tmp/no)" )).toBe("'a'\\''b $(touch /tmp/no)'")
    const command = managedPosixCommand('/bin/claude', ['--print', '$(touch /tmp/no);'], '/work space', { key: 'CLAUDE_CONFIG_DIR', path: '/config space' })
    expect(command).toBe("cd '/work space' && exec env CLAUDE_CONFIG_DIR='/config space' '/bin/claude' '--print' '$(touch /tmp/no);'")
    expect(managedSshArguments('owned-host', command)).toContain('StrictHostKeyChecking=yes')
    expect(() => managedSshArguments('-oProxyCommand=bad', command)).toThrow('Invalid')
    expect(managedWslArguments('Ubuntu', command, 'user')).toEqual(['-d', 'Ubuntu', '-u', 'user', '--exec', '/bin/sh', '-c', command])
  })
  it('requires observed child exit, not killed=true, and fences later launches', async () => {
    vi.useFakeTimers()
    const child = Object.assign(new EventEmitter(), { killed: true, exitCode: null, signalCode: null })
    const spawn = vi.fn<ManagedNativeSpawn>(() => child as unknown as ChildProcessWithoutNullStreams)
    const plan = new ManagedLaunchRegistry({}, spawn).resolve({ agent: 'claude', workspacePath: '/work' })
    plan.spawn('claude', [])
    try {
      const proof = plan.awaitExitProof(10)
      const rejected = expect(proof).rejects.toThrow('exit is unproven')
      await vi.advanceTimersByTimeAsync(10)
      await rejected
      expect(() => plan.spawn('claude', [])).toThrow('retiring')
      child.emit('exit', null, 'SIGTERM')
      await expect(plan.awaitExitProof(10)).resolves.toBeUndefined()
    } finally { vi.useRealTimers() }
  })

  it('accepts close evidence and a query factory which never spawned', async () => {
    const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null })
    const spawn = vi.fn<ManagedNativeSpawn>(() => child as unknown as ChildProcessWithoutNullStreams)
    const registry = new ManagedLaunchRegistry({}, spawn)
    const plan = registry.resolve({ agent: 'claude', workspacePath: '/work' })
    plan.spawn('claude', [])
    const proof = plan.awaitExitProof()
    child.emit('close', 0)
    await expect(proof).resolves.toBeUndefined()
    await expect(registry.resolve({ agent: 'claude', workspacePath: '/work' }).awaitExitProof()).resolves.toBeUndefined()
  })

})
