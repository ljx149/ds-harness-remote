import { describe, it, expect, vi } from 'vitest'
import { ManagedModelDirectory, installManagedModelDirectories } from '../src/client/managed-model-directory.js'
const projection = () => ({ getSnapshot: () => ({ next: null }), subscribe: () => () => {} })
describe('managed native model directory', () => {
  it('loads a blank session by ID and only exposes its own provider', async () => {
    const call = vi.fn(async () => ({ groups: [
      { id: 'claude', name: 'Claude', models: [{ id: 'local-claude', name: 'Local Claude' }] },
      { id: 'codex', name: 'Codex', models: [{ id: 'other', name: 'Other' }] },
    ], current: { provider: 'claude', model: 'local-claude' } }))
    const directory = new ManagedModelDirectory('blank-claude', 'claude', call, projection())
    const state = await directory.load()
    expect(call).toHaveBeenCalledWith('managedAgent.models', { sessionId: 'blank-claude' })
    expect(state.groups.map(group => group.id)).toEqual(['claude'])
    expect(state.current?.model).toBe('local-claude')
    expect(state.routable).toBe(true)
    directory.dispose()
  })
  it('allows retry after a failed load, retaining provider-specific errors', async () => {
    const call = vi.fn().mockRejectedValueOnce(new Error('CLAUDE_UNAVAILABLE')).mockResolvedValueOnce({ groups: [] })
    const directory = new ManagedModelDirectory('claude', 'claude', call, projection())
    await expect(directory.load()).rejects.toThrow('CLAUDE_UNAVAILABLE')
    expect(directory.store.getSnapshot().error).toBe('CLAUDE_UNAVAILABLE')
    await directory.load()
    expect(directory.store.getSnapshot().error).toBeNull()
    directory.dispose()
  })
  it('discards a late catalog response from a disconnected Host', async () => {
    let complete!: (value: unknown) => void
    const directory = new ManagedModelDirectory('codex', 'codex', () => new Promise(resolve => { complete = resolve }), projection())
    const loading = directory.load()
    directory.resetConnected()
    complete({ groups: [{ id: 'codex', models: [] }] })
    await loading
    expect(directory.store.getSnapshot().groups).toEqual([])
    directory.dispose()
  })
  it('preserves the native directory for ordinary DSH sessions and restores on disposal', () => {
    const original = vi.fn(() => 'native')
    const resolver = { directoryFor: original as (id: string) => unknown }
    const cleanup = installManagedModelDirectories({ resolver, sessions: { binding: () => undefined, scope: () => undefined }, call: vi.fn() })
    expect(resolver.directoryFor('dsh')).toBe('native')
    cleanup()
    expect(resolver.directoryFor).toBe(original)
  })
})
