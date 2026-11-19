// Linux incarnation/token ownership follows Orca's conservative evidence model.
// MIT reference: ORCA-LICENSE. Unknown is never evidence of process exit.
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { ManagedNativeSpawn } from './launch.js'

const TOKEN_ENV = 'XCODEX_MANAGED_SPAWN_TOKEN'
const identitySchema = z.object({ pid: z.number().int().positive(), startTicks: z.string().regex(/^\d+$/), bootId: z.string().min(1).max(128), uid: z.number().int().nonnegative() }).strict()
export type ManagedProcessIdentity = z.infer<typeof identitySchema>
export type ManagedProcessProbe = { kind: 'absent' } | { kind: 'unknown' } | { kind: 'present'; identity: ManagedProcessIdentity; tokenMatches: boolean; zombie?: boolean }
export interface ManagedProcessEvidence {
  platform: string
  self(): ManagedProcessIdentity | undefined
  probe(pid: number, token: string): ManagedProcessProbe
  scan(token: string, uid: number): { complete: boolean; processes: ManagedProcessIdentity[] }
}
const recordSchema = z.object({
  version: z.literal(1), sessionId: z.string().min(1).max(512), agent: z.string().min(1).max(128),
  fence: z.string().uuid(), spawnToken: z.string().uuid(), phase: z.enum(['reserved', 'running', 'blocked', 'exited']),
  launcher: identitySchema.nullable(), child: identitySchema.nullable(), rootExitConfirmed: z.boolean().optional(), createdAt: z.number().finite(), updatedAt: z.number().finite(), reason: z.string().max(128).optional(),
}).strict()
type OwnershipRecord = z.infer<typeof recordSchema>
export type ManagedProcessRecovery = { state: 'absent' | 'exited' | 'live-owned' | 'blocked'; maySpawn: boolean; reason?: string; pid?: number; fence?: string }
const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT' || (error as NodeJS.ErrnoException)?.code === 'ESRCH'
const same = (a: ManagedProcessIdentity, b: ManagedProcessIdentity) => a.pid === b.pid && a.uid === b.uid && a.startTicks === b.startTicks && a.bootId === b.bootId

export function parseManagedLinuxStat(value: string): { startTicks: string; zombie: boolean } | undefined {
  const end = value.lastIndexOf(')')
  if (end < 0) return undefined
  const fields = value.slice(end + 1).trim().split(/\s+/)
  const startTicks = fields[19]
  return startTicks && /^\d+$/.test(startTicks) ? { startTicks, zombie: fields[0] === 'Z' || fields[0] === 'X' } : undefined
}
/** Bounded read; environment bytes are never returned, persisted or logged. */
function environmentMatches(pid: number, token: string): boolean | undefined {
  const fd = openSync(`/proc/${pid}/environ`, 'r')
  try {
    const bytes = Buffer.alloc(64 * 1024 + 1)
    let size = 0
    for (;;) {
      const read = readSync(fd, bytes, size, bytes.length - size, null)
      size += read
      if (!read) break
      if (size === bytes.length) return undefined
    }
    const expected = Buffer.from(`${TOKEN_ENV}=${token}`)
    return bytes.subarray(0, size).toString('utf8').split('\0').some(entry => Buffer.from(entry).equals(expected))
  } finally { closeSync(fd) }
}
function incarnation(pid: number): { identity: ManagedProcessIdentity; zombie: boolean } | undefined {
  const parsed = parseManagedLinuxStat(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  if (!parsed || !bootId) return undefined
  return { identity: { pid, startTicks: parsed.startTicks, bootId, uid: statSync(`/proc/${pid}`).uid }, zombie: parsed.zombie }
}
export const linuxManagedProcessEvidence: ManagedProcessEvidence = {
  platform: process.platform,
  self: () => { if (process.platform !== 'linux') return undefined; try { return incarnation(process.pid)?.identity } catch { return undefined } },
  probe: (pid, token) => {
    if (process.platform !== 'linux') return { kind: 'unknown' }
    try {
      const before = incarnation(pid)
      if (!before) return { kind: 'unknown' }
      const tokenMatches = environmentMatches(pid, token)
      const after = incarnation(pid)
      if (!after || !same(before.identity, after.identity) || tokenMatches === undefined) return { kind: 'unknown' }
      return { kind: 'present', identity: after.identity, zombie: after.zombie, tokenMatches }
    } catch (error) { return absent(error) ? { kind: 'absent' } : { kind: 'unknown' } }
  },
  scan: (token, _uid) => {
    const processes: ManagedProcessIdentity[] = []
    if (process.platform !== 'linux') return { complete: false, processes }
    let names: string[]
    try { names = readdirSync('/proc').filter(name => /^\d+$/.test(name)) } catch { return { complete: false, processes } }
    if (names.length > 1024) return { complete: false, processes }
    let complete = true
    for (const name of names) {
      const pid = Number(name)
      try {
        // Include changed-UID descendants: restricting to the original UID
        // could falsely declare a sudo/setuid child gone. Unreadable entries
        // make the scan incomplete, never permission to acquire another child.
        const result = linuxManagedProcessEvidence.probe(pid, token)
        if (result.kind === 'unknown') { complete = false; continue }
        if (result.kind === 'present' && result.tokenMatches && !result.zombie) processes.push(result.identity)
      } catch (error) { if (!absent(error)) complete = false }
    }
    try {
      const after = readdirSync('/proc').filter(name => /^\d+$/.test(name))
      const before = new Set(names)
      if (after.length !== before.size || after.some(name => !before.has(name))) complete = false
    } catch { complete = false }
    return { complete, processes }
  },
}

/** Construct only while holding ManagedSessionStore's exclusive writer lock.
 * Journals contain incarnation IDs and a random spawn marker, not CLI args,
 * prompts, configuration homes, credentials or complete environment snapshots.
 * Recovery deliberately does not signal PIDs: Node has no atomic pidfd signal
 * primitive, and check-then-kill permits PID reuse. Live or unknown work blocks
 * new acquisition until an owner-controlled close produces absence evidence. */
export class ManagedProcessOwnership {
  constructor(private readonly directory: string, options: { exclusiveHostLockHeld: true; evidence?: ManagedProcessEvidence }) {
    if (options.exclusiveHostLockHeld !== true) throw new Error('Managed process ownership requires the exclusive Host store lock.')
    this.evidence = options.evidence ?? linuxManagedProcessEvidence
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const info = lstatSync(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error('Unsafe managed process ownership directory.')
  }
  private readonly evidence: ManagedProcessEvidence
  private path(sessionId: string): string { return join(this.directory, `${createHash('sha256').update(sessionId).digest('hex')}.json`) }
  private read(sessionId: string): OwnershipRecord | undefined {
    const path = this.path(sessionId)
    try {
      const info = lstatSync(path)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 8192) throw new Error('Unsafe managed process ownership record.')
      const record = recordSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
      if (record.sessionId !== sessionId) throw new Error('Managed process ownership identity mismatch.')
      return record
    } catch (error) { if (absent(error)) return undefined; throw error }
  }
  private write(record: OwnershipRecord): void {
    const temporary = join(this.directory, `${randomUUID()}.tmp`)
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd) } finally { closeSync(fd) }
    try {
      renameSync(temporary, this.path(record.sessionId))
      const directory = openSync(this.directory, constants.O_RDONLY)
      try { fsyncSync(directory) } finally { closeSync(directory) }
    } finally { try { unlinkSync(temporary) } catch (error) { if (!absent(error)) throw error } }
  }
  private update(expected: OwnershipRecord, phase: OwnershipRecord['phase'], reason?: string, child?: ManagedProcessIdentity | null, rootExitConfirmed?: true): void {
    const current = this.read(expected.sessionId)
    if (!current || current.fence !== expected.fence || current.spawnToken !== expected.spawnToken) return
    this.write({ ...current, phase, child: child === undefined ? current.child : child, updatedAt: Date.now(), ...(rootExitConfirmed ? { rootExitConfirmed: true } : {}), ...(reason ? { reason } : {}) })
  }
  recover(sessionId: string): ManagedProcessRecovery {
    let record: OwnershipRecord | undefined
    try { record = this.read(sessionId) } catch { return { state: 'blocked', maySpawn: false, reason: 'invalid-ownership-record' } }
    if (!record) return { state: 'absent', maySpawn: true }
    if (record.phase === 'exited') return { state: 'exited', maySpawn: true, fence: record.fence }
    if (this.evidence.platform !== 'linux' || !record.launcher) return { state: 'blocked', maySpawn: false, reason: 'process-evidence-unavailable', fence: record.fence }
    const scan = this.evidence.scan(record.spawnToken, record.launcher.uid)
    if (!scan.complete) return { state: 'blocked', maySpawn: false, reason: 'process-scan-incomplete', fence: record.fence }
    if (record.child) {
      const child = this.evidence.probe(record.child.pid, record.spawnToken)
      if (child.kind === 'unknown') return { state: 'blocked', maySpawn: false, reason: 'process-identity-unknown', fence: record.fence }
      if (child.kind === 'present' && child.identity.pid === record.child.pid && child.identity.startTicks === record.child.startTicks && child.identity.bootId === record.child.bootId && child.identity.uid !== record.child.uid && !child.zombie) {
        return { state: 'blocked', maySpawn: false, reason: 'process-owner-changed', fence: record.fence }
      }
      if (child.kind === 'present' && same(child.identity, record.child) && !child.zombie) {
        return child.tokenMatches ? { state: 'live-owned', maySpawn: false, pid: record.child.pid, fence: record.fence }
          : { state: 'blocked', maySpawn: false, reason: 'spawn-marker-mismatch', fence: record.fence }
      }
    }
    if (scan.processes.length) return { state: 'blocked', maySpawn: false, reason: 'spawn-descendants-or-unbound-child-present', fence: record.fence }
    if (!record.child && !record.rootExitConfirmed) {
      const launcher = this.evidence.probe(record.launcher.pid, record.spawnToken)
      if (launcher.kind === 'unknown' || (launcher.kind === 'present' && same(launcher.identity, record.launcher) && !launcher.zombie)) {
        return { state: 'blocked', maySpawn: false, reason: 'reservation-launcher-still-possible', fence: record.fence }
      }
    }
    this.update(record, 'exited', 'absence-confirmed')
    return { state: 'exited', maySpawn: true, fence: record.fence }
  }
  forSession(input: { sessionId: string; agent: string }, nativeSpawn: ManagedNativeSpawn = spawn): ManagedNativeSpawn {
    return (command, args, options) => {
      if (!this.recover(input.sessionId).maySpawn) throw new Error('Managed process recovery is blocked; an existing child must be reconciled before spawning.')
      const launcher = this.evidence.self()
      if (this.evidence.platform !== 'linux' || !launcher) throw new Error('Durable managed process ownership is unavailable on this platform.')
      const now = Date.now()
      const record: OwnershipRecord = recordSchema.parse({ version: 1, ...input, fence: randomUUID(), spawnToken: randomUUID(), phase: 'reserved', launcher, child: null, createdAt: now, updatedAt: now })
      this.write(record) // Before spawn: crashes in the gap recover by token scan.
      let child: ReturnType<ManagedNativeSpawn>
      try { child = nativeSpawn(command, args, { ...options, env: { ...options.env, [TOKEN_ENV]: record.spawnToken } }) }
      catch (error) { this.update(record, 'blocked', 'spawn-outcome-unknown'); throw error }
      const bind = () => {
        try {
          if (!child.pid) { this.update(record, 'blocked', 'spawn-pid-unavailable'); return }
          const evidence = this.evidence.probe(child.pid, record.spawnToken)
          if (evidence.kind !== 'present' || !evidence.tokenMatches || evidence.zombie) { this.update(record, 'blocked', 'spawn-identity-unverified'); return }
          this.update(record, 'running', undefined, evidence.identity)
        } catch { try { this.update(record, 'blocked', 'ownership-write-failed') } catch { /* durable reservation remains blocking */ } }
      }
      child.once('spawn', bind)
      child.once('error', () => {
        try { if (!child.pid) this.update(record, 'exited', 'spawn-failed-before-pid'); else this.update(record, 'blocked', 'child-error-unverified') } catch { /* keep reservation */ }
      })
      child.once('exit', () => {
        try {
          const latest = this.read(record.sessionId)
          if (latest?.fence !== record.fence) return
          // This callback belongs to the exact ChildProcess we spawned, not an
          // arbitrary observed PID. Still require no surviving marked children.
          const remaining = this.evidence.scan(record.spawnToken, launcher.uid)
          if (remaining.complete && remaining.processes.length === 0) this.update(record, 'exited', 'owned-child-exit-confirmed', undefined, true)
          else this.update(record, 'blocked', 'child-exited-descendants-unconfirmed', undefined, true)
        } catch { /* never clear ownership on a failed inspection */ }
      })
      return child
    }
  }
}
