import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import type { Options } from '@anthropic-ai/claude-agent-sdk'

export interface ManagedLaunchProfile { id: string; label: string; codexHome?: string; claudeConfigDir?: string }
export interface ManagedLaunchSelection { profileId?: string }
export type ManagedNativeSpawn = (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio & { stdio: ['pipe', 'pipe', 'pipe'] }) => ChildProcessWithoutNullStreams
/** Native execution only: account homes are Host configuration, never RPC input. */
export class ManagedLaunchRegistry {
  private readonly profiles = new Map<string, ManagedLaunchProfile>([['host', { id: 'host', label: 'Computer configuration' }]])
  constructor(configuration: { profiles?: readonly ManagedLaunchProfile[] } = {}, private readonly nativeSpawn: ManagedNativeSpawn = spawn, private readonly spawnForSession?: (input: { sessionId: string; agent: string }) => ManagedNativeSpawn) {
    for (const profile of configuration.profiles ?? []) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(profile.id) || this.profiles.has(profile.id)) throw new Error('Invalid or duplicate profile identity.')
      for (const home of [profile.codexHome, profile.claudeConfigDir]) if (home !== undefined && (!isAbsolute(home) || home.includes('\0'))) throw new Error('Profile path must be absolute.')
      this.profiles.set(profile.id, { ...profile })
    }
  }
  options(agent: string): Array<{ id: string; label: string }> {
    return [...this.profiles.values()].filter(profile => profile.id === 'host' || (agent === 'codex' ? profile.codexHome : profile.claudeConfigDir)).map(({ id, label }) => ({ id, label }))
  }
  resolve(input: { sessionId: string; agent: string; workspacePath: string; selection?: ManagedLaunchSelection; previousFingerprint?: string }): ManagedLaunchPlan {
    if (!['claude', 'codex'].includes(input.agent) || !isAbsolute(input.workspacePath)) throw new Error('Invalid launch context.')
    const profile = this.profiles.get(input.selection?.profileId ?? 'host')
    if (!profile || !this.options(input.agent).some(item => item.id === profile.id)) throw new Error('Launch profile is unavailable.')
    const plan = new ManagedLaunchPlan(profile, input.agent, input.workspacePath, this.spawnForSession?.({ sessionId: input.sessionId, agent: input.agent }) ?? this.nativeSpawn)
    if (input.previousFingerprint && input.previousFingerprint !== plan.ownerFingerprint) throw new Error('Conversation launch profile changed; restore its original configuration.')
    return plan
  }
}
export class ManagedLaunchPlan {
  readonly ownerFingerprint: string
  private exits: Promise<void>[] = []
  constructor(private readonly profile: ManagedLaunchProfile, private readonly agent: string, readonly cwd: string, private readonly nativeSpawn: ManagedNativeSpawn) {
    this.ownerFingerprint = createHash('sha256').update(JSON.stringify({ profileId: profile.id, agent, cwd, home: agent === 'codex' ? profile.codexHome : profile.claudeConfigDir })).digest('hex')
  }
  environment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env = { ...base }
    if (this.profile.id !== 'host') {
      for (const key of this.agent === 'codex' ? ['OPENAI_API_KEY','OPENAI_BASE_URL','CODEX_API_KEY','CODEX_HOME'] : ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CONFIG_DIR']) delete env[key]
      env[this.agent === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] = this.agent === 'codex' ? this.profile.codexHome : this.profile.claudeConfigDir
    }
    return env
  }
  spawn(command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}): ChildProcessWithoutNullStreams {
    const child = this.nativeSpawn(command, args, { cwd: this.cwd, env: this.environment(options.env), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...(options.signal ? { signal: options.signal } : {}) })
    this.exits.push(new Promise(resolve => {
      const done = () => { child.removeListener('exit', done); child.removeListener('close', done); resolve() }
      child.once('exit', done); child.once('close', done)
      if (child.exitCode != null || child.signalCode != null) done()
    }))
    return child
  }
  claudeOptions(): Pick<Options, 'cwd' | 'env' | 'spawnClaudeCodeProcess'> {
    return { cwd: this.cwd, env: this.environment(), spawnClaudeCodeProcess: options => this.spawn(options.command, options.args, { env: options.env, signal: options.signal }) }
  }
  async awaitExitProof(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([Promise.all(this.exits), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Managed child exit is unconfirmed.')), 5000) })]) }
    finally { clearTimeout(timer) }
  }
}
export const defaultManagedLaunchRegistry = new ManagedLaunchRegistry()
