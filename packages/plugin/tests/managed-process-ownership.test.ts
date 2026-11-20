import { EventEmitter } from 'node:events'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManagedProcessOwnership, parseManagedLinuxStat, type ManagedProcessEvidence, type ManagedProcessIdentity, type ManagedProcessProbe } from '../src/managed-agents/process-ownership.js'
import type { ManagedNativeSpawn } from '../src/managed-agents/launch.js'

const dirs: string[] = []
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }) })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'managed-process-ownership-')); dirs.push(directory)
  const launcher: ManagedProcessIdentity = { pid: 101, startTicks: '123', bootId: 'test-boot', uid: 1000 }
  const processIdentity: ManagedProcessIdentity = { pid: 202, startTicks: '456', bootId: 'test-boot', uid: 1000 }
  let token = '', launcherAlive = true, childAlive = false, tokenMatches = true, scanComplete = true, extra: ManagedProcessIdentity[] = []
  let current = processIdentity
  const child = Object.assign(new EventEmitter(), { pid: 202 }) as ReturnType<ManagedNativeSpawn>
  const evidence: ManagedProcessEvidence = {
    platform: 'linux', self: () => launcher,
    probe: (pid, requested): ManagedProcessProbe => {
      if (pid === launcher.pid) return launcherAlive ? { kind: 'present', identity: launcher, tokenMatches: false } : { kind: 'absent' }
      return childAlive ? { kind: 'present', identity: current, tokenMatches: tokenMatches && requested === token } : { kind: 'absent' }
    },
    scan: () => ({ complete: scanComplete, processes: [...(childAlive && tokenMatches ? [current] : []), ...extra] }),
  }
  const native = vi.fn<ManagedNativeSpawn>((_command, _args, options) => {
    // Durable reservation must already exist at the actual spawn boundary.
    expect(readdirSync(directory).filter(file => file.endsWith('.json'))).toHaveLength(1)
    token = options.env?.XCODEX_MANAGED_SPAWN_TOKEN ?? ''
    expect(token).toMatch(/^[a-f0-9-]{36}$/)
    childAlive = true
    return child
  })
  const ownership = new ManagedProcessOwnership(directory, { exclusiveHostLockHeld: true, evidence })
  const start = () => ownership.forSession({ sessionId: 'session', agent: 'codex' }, native)('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], env: { PRIVATE_KEY: 'not-to-be-persisted' } })
  return { directory, evidence, ownership, start, native, child, launcher, processIdentity,
    setLauncherAlive: (value: boolean) => { launcherAlive = value },
    setChildAlive: (value: boolean) => { childAlive = value },
    setIdentity: (value: ManagedProcessIdentity) => { current = value },
    setTokenMatches: (value: boolean) => { tokenMatches = value },
    setScanComplete: (value: boolean) => { scanComplete = value },
    setExtra: (value: ManagedProcessIdentity[]) => { extra = value },
  }
}

describe('durable local managed process ownership', () => {
  it('reserves before spawn, persists incarnation on spawn, and never stores CLI environment', () => {
    const f = fixture(); f.start(); f.child.emit('spawn')
    expect(f.ownership.recover('session')).toMatchObject({ state: 'live-owned', maySpawn: false, pid: 202 })
    const persisted = readFileSync(join(f.directory, readdirSync(f.directory).find(file => file.endsWith('.json'))!), 'utf8')
    expect(persisted).not.toContain('PRIVATE_KEY')
    expect(persisted).not.toContain('not-to-be-persisted')
    expect(JSON.parse(persisted).child).toEqual(f.processIdentity)
    expect(() => f.start()).toThrow('blocked')
    expect(f.native).toHaveBeenCalledTimes(1)
  })
  it('recovers a crash between spawn and incarnation write by finding the marker, not starting a duplicate', () => {
    const f = fixture(); f.start(); f.setLauncherAlive(false)
    const reopened = new ManagedProcessOwnership(f.directory, { exclusiveHostLockHeld: true, evidence: f.evidence })
    expect(reopened.recover('session')).toMatchObject({ state: 'blocked', maySpawn: false, reason: 'spawn-descendants-or-unbound-child-present' })
  })
  it('allows restart only after confirmed absence, including a reused PID with a different incarnation', () => {
    const f = fixture(); f.start(); f.child.emit('spawn'); f.setLauncherAlive(false)
    f.setIdentity({ ...f.processIdentity, startTicks: '999' }); f.setTokenMatches(false)
    const reopened = new ManagedProcessOwnership(f.directory, { exclusiveHostLockHeld: true, evidence: f.evidence })
    expect(reopened.recover('session')).toMatchObject({ state: 'exited', maySpawn: true })
    // No signal or kill API is part of the controller: the unrelated reused PID is untouched.
  })
  it('keeps unknown inspection and live marker mismatch blocked', () => {
    const f = fixture(); f.start(); f.child.emit('spawn')
    f.setScanComplete(false)
    expect(f.ownership.recover('session')).toMatchObject({ state: 'blocked', maySpawn: false })
    f.setScanComplete(true); f.setTokenMatches(false)
    expect(f.ownership.recover('session')).toMatchObject({ state: 'blocked', reason: 'spawn-marker-mismatch' })
  })
  it('does not release ownership when root exit leaves a marked descendant', () => {
    const f = fixture(); f.start(); f.child.emit('spawn'); f.setChildAlive(false)
    f.setExtra([{ ...f.processIdentity, pid: 303 }]); f.child.emit('exit', 0)
    expect(f.ownership.recover('session')).toMatchObject({ state: 'blocked', maySpawn: false })
    const record = JSON.parse(readFileSync(join(f.directory, readdirSync(f.directory).find(file => file.endsWith('.json'))!), 'utf8'))
    expect(record.child).toEqual(f.processIdentity)
    expect(record.rootExitConfirmed).toBe(true)
    f.setExtra([])
    expect(f.ownership.recover('session')).toMatchObject({ state: 'exited', maySpawn: true })
  })
  it('retains exact ChildProcess exit evidence even when incarnation capture failed before exit', () => {
    const f = fixture(); f.start(); f.setTokenMatches(false); f.child.emit('spawn')
    f.setChildAlive(false); f.setExtra([{ ...f.processIdentity, pid: 303 }]); f.child.emit('exit', 0)
    expect(f.ownership.recover('session').maySpawn).toBe(false)
    f.setExtra([])
    const reopened = new ManagedProcessOwnership(f.directory, { exclusiveHostLockHeld: true, evidence: f.evidence })
    expect(reopened.recover('session')).toMatchObject({ state: 'exited', maySpawn: true })
  })
  it('records exact child exit before allowing the next acquisition', () => {
    const f = fixture(); f.start(); f.child.emit('spawn'); f.setChildAlive(false); f.child.emit('exit', 0)
    expect(f.ownership.recover('session').maySpawn).toBe(true)
    f.start(); f.child.emit('spawn')
    expect(f.ownership.recover('session').maySpawn).toBe(false)
  })
  it('fails closed on platforms without supported incarnation evidence before invoking spawn', () => {
    const f = fixture(); f.evidence.platform = 'darwin'
    expect(() => f.start()).toThrow('unavailable')
    expect(f.native).not.toHaveBeenCalled()
  })
  it('parses Linux start ticks with spaces and parentheses in the executable name', () => {
    const stat = `202 (worker (agent) process) S ${Array(18).fill('0').join(' ')} 12345 0`
    expect(parseManagedLinuxStat(stat)).toEqual({ startTicks: '12345', zombie: false })
    expect(parseManagedLinuxStat('invalid')).toBeUndefined()
  })
})
