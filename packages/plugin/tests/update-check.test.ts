import { describe, expect, it, vi } from 'vitest'
import { latestPluginRelease, PluginUpdateChecker } from '../src/update-check.js'
import { SafeLogger } from '../src/logging.js'
const release = (version: string) => ({ tag_name: `xcodex-remote-${version}`, prerelease: version.includes('-'), draft: false, assets: [{ name: `xcodex-remote-${version}.tgz`, state: 'uploaded', browser_download_url: `https://github.com/ljx149/ds-harness-remote/releases/download/xcodex-remote-${version}/xcodex-remote-${version}.tgz` }] })
describe('fork release update discovery', () => {
  it('compares preview versions numerically, regardless of release ordering', () => {
    expect(latestPluginRelease([release('0.7.0-xcodex.9'), release('0.7.0-xcodex.10')], '0.7.0-xcodex.3')).toBe('0.7.0-xcodex.10')
  })
  it('does not offer preview builds to stable installations', () => {
    expect(latestPluginRelease([release('0.8.0-xcodex.1'), release('0.7.1')], '0.7.0')).toBe('0.7.1')
  })
  it('ignores drafts, unrelated releases, missing artifacts and foreign download URLs', () => {
    const foreign = release('9.0.0'); foreign.assets[0]!.browser_download_url = 'https://example.com/plugin.tgz'
    expect(latestPluginRelease([{ ...release('9.0.1'), draft: true }, { tag_name: 'server-v99' }, { ...release('9.0.2'), assets: [] }, foreign, null], '0.7.0-xcodex.3')).toBeUndefined()
  })
  it('checks only the fork and preserves its successful snapshot after network failure', async () => {
    const fetcher = vi.fn(async (_url: unknown, _options?: unknown) => new Response(JSON.stringify([release('0.7.0-xcodex.10')]), { status: 200 }))
    const logger = new SafeLogger({ debug() {}, info() {}, warn() {}, error() {} })
    const checker = new PluginUpdateChecker(logger, fetcher)
    await checker.check()
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.github.com/repos/ljx149/ds-harness-remote/releases?per_page=100')
    const snapshot = checker.snapshot()
    expect(snapshot?.latestVersion).toBe('0.7.0-xcodex.10')
    fetcher.mockRejectedValueOnce(new Error('offline'))
    await checker.check()
    expect(checker.snapshot()).toBe(snapshot)
    checker.stop()
    await checker.check()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
