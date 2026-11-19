// Host-owned profile/launch boundary adapted from Orca account routing. MIT; see ORCA-LICENSE.
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import type { Options } from '@anthropic-ai/claude-agent-sdk'

export interface ManagedLaunchSelection { profileId?: string; locationId?: string }
export interface ManagedLaunchProfile {
  id: string
  label: string
  agents?: readonly ('claude' | 'codex')[]
  /** Existing credential/config homes only. Never copied, migrated or returned over RPC. */
  codexHome?: string
  claudeConfigDir?: string
  /** Host-local values. Never accept this object from RPC or log it. */
  environment?: Readonly<Record<string, string>>
  executables?: Readonly<Partial<Record<'claude' | 'codex', string>>>
}
export interface ManagedLaunchLocation {
  id: string
  label: string
  kind: 'native' | 'ssh' | 'wsl' | 'daemon'
  /** Exact trusted Host workspace -> executor workspace mapping; no prefix guesses. */
  workspaceMap?: Readonly<Record<string, string>>
}
export interface ManagedOwnedTransport {
  /** Registration is only permitted after the transport can account for and
   * terminate its exact remote tree; plain ssh.kill() does not meet this. */
  readonly ownership: 'process-tree'
  readonly ready: boolean
  spawn(input: { command: string; args: readonly string[]; cwd: string; profileHome?: { key: 'CODEX_HOME' | 'CLAUDE_CONFIG_DIR'; path: string }; signal?: AbortSignal }): ChildProcessWithoutNullStreams
}
export interface ManagedLaunchConfiguration {
  profiles?: readonly ManagedLaunchProfile[]
  locations?: readonly ManagedLaunchLocation[]
}
export type ManagedNativeSpawn = (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio & { stdio: ['pipe', 'pipe', 'pipe'] }) => ChildProcessWithoutNullStreams
const accountKeys: Record<string, readonly string[]> = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR'],
  codex: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_HOME'],
}
const id = (value: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value)) throw new Error('Invalid launch identity.')
  return value
}
const path = (value: string) => {
  if (!value || value.includes('\0') || !isAbsolute(value)) throw new Error('Launch path must be absolute.')
  return value
}
export class ManagedLaunchPlan {
  readonly selection: Readonly<Required<ManagedLaunchSelection>>
  readonly ownerFingerprint: string
  readonly cwd: string
  readonly kind: ManagedLaunchLocation['kind']
  #profile: ManagedLaunchProfile
  #agent: 'claude' | 'codex'
  #transport: ManagedOwnedTransport | undefined
  #nativeSpawn: ManagedNativeSpawn
  #exits: Promise<void>[] = []
  #retiring = false
  constructor(input: { profile: ManagedLaunchProfile; location: ManagedLaunchLocation; agent: 'claude' | 'codex'; cwd: string; transport?: ManagedOwnedTransport; nativeSpawn: ManagedNativeSpawn }) {
    this.#profile = input.profile; this.#agent = input.agent; this.cwd = input.cwd; this.kind = input.location.kind
    this.#transport = input.transport; this.#nativeSpawn = input.nativeSpawn
    this.selection = Object.freeze({ profileId: input.profile.id, locationId: input.location.id })
    // Freeze routing, not rotating access tokens. Only the digest is persisted.
    const routingKeys = ['HOME', 'USERPROFILE', 'PATH', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL']
    const routing = Object.fromEntries(routingKeys.map(key => [key, input.profile.environment?.[key] ?? (input.location.kind === 'native' ? process.env[key] : undefined)]))
    this.ownerFingerprint = createHash('sha256').update(JSON.stringify({
      version: 1, agent: input.agent, profileId: input.profile.id, locationId: input.location.id,
      kind: input.location.kind, cwd: input.cwd, home: input.agent === 'claude' ? input.profile.claudeConfigDir : input.profile.codexHome,
      executable: input.profile.executables?.[input.agent], routing,
    })).digest('hex')
  }
  toJSON(): unknown { return { ...this.selection, kind: this.kind } }
  executable(fallback: string): string { return this.#profile.executables?.[this.#agent] ?? fallback }
  /** Restore the selected account home after inherited SDK options, rather than
   * allowing a different active account's env to silently override this owner. */
  environment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    if (this.kind !== 'native') throw new Error('Remote credentials stay on the executor.')
    const env = { ...base }
    if (this.selection.profileId !== 'host') for (const key of accountKeys[this.#agent]!) delete env[key]
    Object.assign(env, this.#profile.environment)
    const home = this.#agent === 'claude' ? this.#profile.claudeConfigDir : this.#profile.codexHome
    if (home) env[this.#agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'] = home
    return env
  }
  spawn(command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}): ChildProcessWithoutNullStreams {
    if (this.#retiring) throw new Error('Managed launch is retiring.')
    if (!command || command.includes('\0') || args.some(arg => arg.includes('\0'))) throw new Error('Invalid launch arguments.')
    if (options.signal?.aborted) throw new Error('Launch cancelled.')
    if (this.kind !== 'native') {
      if (!this.#transport?.ready) throw new Error('Owned execution transport is unavailable.')
      const home = this.#agent === 'claude' ? this.#profile.claudeConfigDir : this.#profile.codexHome
      return this.track(this.#transport.spawn({ command, args, cwd: this.cwd, ...(home ? { profileHome: { key: this.#agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME', path: home } } : {}), ...(options.signal ? { signal: options.signal } : {}) }))
    }
    return this.track(this.#nativeSpawn(command, args, { cwd: this.cwd, env: this.environment(options.env), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...(options.signal ? { signal: options.signal } : {}) }))
  }
  private track(child: ChildProcessWithoutNullStreams): ChildProcessWithoutNullStreams {
    this.#exits.push(new Promise<void>(resolve => {
      const exited = () => { child.removeListener?.('exit', exited); child.removeListener?.('close', exited); resolve() }
      child.once?.('exit', exited)
      child.once?.('close', exited)
      if (child.exitCode != null || child.signalCode != null) exited()
    }))
    return child
  }
  /** Proves only the child roots returned by spawn, not descendant-tree death.
   * Ownership recovery must still reject any surviving/unproven descendant. */
  async awaitExitProof(timeoutMs = 5000): Promise<void> {
    this.#retiring = true
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([Promise.all(this.#exits), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Managed child process exit is unproven.')), timeoutMs)
        timer.unref?.()
      })])
    } finally { clearTimeout(timer) }
  }
  claudeOptions(): Pick<Options, 'cwd' | 'env' | 'spawnClaudeCodeProcess'> {
    return {
      cwd: this.cwd,
      ...(this.kind === 'native' ? { env: this.environment() } : {}),
      spawnClaudeCodeProcess: options => this.spawn(options.command, options.args, { ...(this.kind === 'native' ? { env: options.env } : {}), signal: options.signal }),
    }
  }
}

/** Only names cross RPC. Definitions and transport implementations are supplied
 * by the Host, and missing/removed owners fail closed rather than falling back. */
export class ManagedLaunchRegistry {
  #profiles = new Map<string, ManagedLaunchProfile>([['host', { id: 'host', label: 'Computer configuration' }]])
  #locations = new Map<string, ManagedLaunchLocation>([['native', { id: 'native', label: 'This computer', kind: 'native' }]])
  #transports = new Map<string, ManagedOwnedTransport>()
  constructor(configuration: ManagedLaunchConfiguration = {}, private readonly nativeSpawn: ManagedNativeSpawn = spawn, private readonly spawnForSession?: (identity: { sessionId: string; agent: string }) => ManagedNativeSpawn) {
    for (const profile of configuration.profiles ?? []) {
      id(profile.id)
      if (this.#profiles.has(profile.id)) throw new Error('Duplicate launch profile.')
      if (profile.codexHome) path(profile.codexHome)
      if (profile.claudeConfigDir) path(profile.claudeConfigDir)
      for (const [key, value] of Object.entries(profile.environment ?? {})) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes('\0')) throw new Error('Invalid profile environment.')
      this.#profiles.set(profile.id, { ...profile, environment: profile.environment ? { ...profile.environment } : undefined })
    }
    for (const location of configuration.locations ?? []) {
      id(location.id)
      if (this.#locations.has(location.id)) throw new Error('Duplicate launch location.')
      this.#locations.set(location.id, { ...location, workspaceMap: location.workspaceMap ? { ...location.workspaceMap } : undefined })
    }
  }
  registerTransport(locationId: string, transport: ManagedOwnedTransport): void {
    const location = this.#locations.get(locationId)
    if (!location || location.kind === 'native' || transport.ownership !== 'process-tree') throw new Error('Invalid owned transport registration.')
    this.#transports.set(locationId, transport)
  }
  options(agent: 'claude' | 'codex', workspacePath: string): { profiles: { id: string; label: string }[]; locations: { id: string; label: string; kind: string }[] } {
    return {
      profiles: [...this.#profiles.values()].filter(profile => this.supports(profile, agent)).map(({ id, label }) => ({ id, label })),
      locations: [...this.#locations.values()].filter(location => location.kind === 'native' || (this.#transports.get(location.id)?.ready && location.workspaceMap?.[workspacePath])).map(({ id, label, kind }) => ({ id, label, kind })),
    }
  }
  resolve(input: { sessionId?: string; agent: string; workspacePath: string; selection?: ManagedLaunchSelection; previous?: ManagedLaunchSelection; previousFingerprint?: string; resuming?: boolean }): ManagedLaunchPlan {
    if (input.agent !== 'claude' && input.agent !== 'codex') throw new Error('Unsupported launch agent.')
    const selection = { profileId: input.selection?.profileId ?? 'host', locationId: input.selection?.locationId ?? 'native' }
    const previous = { profileId: input.previous?.profileId ?? 'host', locationId: input.previous?.locationId ?? 'native' }
    if (input.resuming && (selection.profileId !== previous.profileId || selection.locationId !== previous.locationId)) throw new Error('A conversation cannot resume under another account or executor.')
    const profile = this.#profiles.get(selection.profileId)
    const location = this.#locations.get(selection.locationId)
    if (!profile || !location || !this.supports(profile, input.agent)) throw new Error('Launch selection is unavailable.')
    const transport = this.#transports.get(location.id)
    if (location.kind !== 'native' && (!transport?.ready || !location.workspaceMap?.[input.workspacePath] || Object.keys(profile.environment ?? {}).length)) throw new Error('Owned executor or workspace mapping is unavailable.')
    const cwd = location.kind === 'native' ? path(input.workspacePath) : location.workspaceMap![input.workspacePath]!
    if (this.spawnForSession && !input.sessionId) throw new Error('Owned launch requires a session identity.')
    const nativeSpawn = this.spawnForSession ? this.spawnForSession({ sessionId: input.sessionId!, agent: input.agent }) : this.nativeSpawn
    const plan = new ManagedLaunchPlan({ profile, location, agent: input.agent, cwd, transport, nativeSpawn })
    if (input.previousFingerprint && input.previousFingerprint !== plan.ownerFingerprint) throw new Error('The conversation account or executor configuration has changed.')
    if (input.resuming && !input.previousFingerprint && (selection.profileId !== 'host' || selection.locationId !== 'native')) throw new Error('A custom conversation requires its original launch ownership binding.')
    return plan
  }
  private supports(profile: ManagedLaunchProfile, agent: 'claude' | 'codex'): boolean {
    return (!profile.agents || profile.agents.includes(agent)) && (profile.id === 'host' || !!(agent === 'claude' ? profile.claudeConfigDir : profile.codexHome))
  }
}
export const defaultManagedLaunchRegistry = new ManagedLaunchRegistry()
