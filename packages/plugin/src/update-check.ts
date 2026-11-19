import type { FetchImplementation } from './server-api.js'
import type { SafeLogger } from './logging.js'
import { PLUGIN_VERSION } from './version.js'

import { compareVersions } from './version-compare.js'

/** Release lookup result shared with local UI and remote Host version badges. */
export interface PluginUpdateSnapshot {
  currentVersion: string
  latestVersion: string
  checkedAt: number
}

const RELEASES_URL = 'https://api.github.com/repos/ljx149/ds-harness-remote/releases?per_page=100'
const FETCH_TIMEOUT_MS = 10_000
const RECHECK_INTERVAL_MS = 60 * 60 * 1000
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

/** Only our published plugin artifacts qualify; unrelated/server releases do not. */
export function latestPluginRelease(value: unknown, current = PLUGIN_VERSION): string | undefined {
  if (!Array.isArray(value)) return undefined
  const candidates: string[] = []
  for (const release of value) {
    if (!release || typeof release !== 'object' || release.draft === true || typeof release.tag_name !== 'string') continue
    if (!release.tag_name.startsWith('xcodex-remote-')) continue
    const version = release.tag_name.slice('xcodex-remote-'.length)
    if (!SEMVER_PATTERN.test(version)) continue
    // Stable installations never opt into preview builds automatically.
    if ((release.prerelease === true || version.includes('-')) && !current.includes('-')) continue
    const assetName = `xcodex-remote-${version}.tgz`
    const assetUrl = `https://github.com/ljx149/ds-harness-remote/releases/download/${release.tag_name}/${assetName}`
    if (!Array.isArray(release.assets) || !release.assets.some((asset: { name?: string; browser_download_url?: string; state?: string }) =>
      asset?.name === assetName && asset.browser_download_url === assetUrl && asset.state === 'uploaded')) continue
    candidates.push(version)
  }
  return candidates.sort((a, b) => compareVersions(b, a))[0]
}

/** Startup/hourly release discovery; failure preserves the last successful snapshot. */
export class PluginUpdateChecker {
  private state?: PluginUpdateSnapshot
  private timer: ReturnType<typeof setInterval> | undefined
  private flight?: Promise<void>
  private stopped = false

  constructor(
    private readonly logger: SafeLogger,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {}

  /** Latest successful release check, or `undefined` before the first one. */
  snapshot(): PluginUpdateSnapshot | undefined {
    return this.state
  }

  /** Run the first check and re-check hourly. Safe to call more than once. */
  start(): void {
    if (this.stopped || this.timer !== undefined) return
    void this.check().catch(() => undefined)
    this.timer = setInterval(() => { void this.check().catch(() => undefined) }, RECHECK_INTERVAL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** One release check; concurrent callers share the in-flight request. */
  check(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    this.flight ??= this.run().finally(() => { this.flight = undefined })
    return this.flight
  }

  private async run(): Promise<void> {
    try {
      const latest = await this.fetchLatestVersion()
      if (latest === undefined || this.stopped) return
      this.state = { currentVersion: PLUGIN_VERSION, latestVersion: latest, checkedAt: Date.now() }
      this.logger.debug('plugin update check complete', { current: PLUGIN_VERSION, latest })
    } catch {
      // Registry reachability varies by network; a failed check must stay invisible.
      this.logger.debug('plugin update check failed', { code: 'UPDATE_CHECK_FAILED' })
    }
  }

  private async fetchLatestVersion(): Promise<string | undefined> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    timeout.unref?.()
    try {
      const response = await this.fetchImplementation(RELEASES_URL, {
        signal: controller.signal,
        headers: { accept: 'application/vnd.github+json' },
      })
      if (!response.ok) throw new Error('Release lookup failed')
      return latestPluginRelease(await response.json())
    } finally { clearTimeout(timeout) }
  }
}
