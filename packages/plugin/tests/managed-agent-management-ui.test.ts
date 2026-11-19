import { describe, expect, it, vi } from 'vitest'
import { createManagedAgentManagementUi, ManagedManagementAttempts, refreshManagedNativeHistory } from '../src/client/managed-agent-management.js'
import type { ClientReact } from '../src/client/types.js'
import type { ManagedAgentUiContext } from '../src/client/managed-agent.js'

type Element = { type: unknown; props: Record<string, unknown> | null; children: unknown[] }
function render(operations: string[], managed = true, state: Record<string, unknown> = {}) {
  let index = 0
  const React = {
    Fragment: 'fragment',
    createElement: (type: unknown, props: Element['props'], ...children: unknown[]): Element => ({ type, props, children }),
    useState: (initial: unknown) => {
      const slot = index++
      const value = slot === 1 ? managed ? 'session' : undefined : slot === 2 ? true : slot === 3 ? { operations, busy: false, state } : typeof initial === 'function' ? (initial as () => unknown)() : initial
      return [value, () => {}]
    },
    useRef: (initial: unknown) => ({ current: initial }),
    useEffect: () => {},
  } as unknown as ClientReact
  const ctx = {
    chinese: false,
    sessions: { list: { getSnapshot: () => ({ byId: { session: { id: 'session', retainedBy: { mainView: 1 } } } }), subscribe: () => () => {} } },
    workspaces: { list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} } },
    call: vi.fn(async () => ({})), open: vi.fn(),
  } satisfies ManagedAgentUiContext
  return { tree: createManagedAgentManagementUi(React, ctx)(), ctx }
}
function elements(tree: unknown): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(elements)
  if (!tree || typeof tree !== 'object' || !('children' in tree)) return []
  const element = tree as Element
  return [element, ...element.children.flatMap(elements)]
}
const buttons = (tree: unknown) => elements(tree).filter(element => element.type === 'button')

describe('managed native conversation management', () => {
  it('reuses mutation identities after an uncertain result, separating session and intent', async () => {
    let next = 0
    const attempts = new ManagedManagementAttempts(() => `operation-${++next}`)
    const first = await attempts.begin('one', 'fork', { checkpointId: 'point' })
    expect(await attempts.begin('one', 'fork', { checkpointId: 'point' })).toEqual(first)
    expect((await attempts.begin('two', 'fork', { checkpointId: 'point' })).operationId).not.toBe(first.operationId)
    expect((await attempts.begin('one', 'fork', { checkpointId: 'other' })).operationId).not.toBe(first.operationId)
    attempts.acknowledged(first.key)
    expect((await attempts.begin('one', 'fork', { checkpointId: 'point' })).operationId).not.toBe(first.operationId)
  })
  it('restores only a UUID and payload digest across remounts without storing answers or callback codes', async () => {
    const stored = new Map<string, string>()
    const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value) }, removeItem: (key: string) => { stored.delete(key) } }
    const first = new ManagedManagementAttempts(() => 'original-uuid', () => storage)
    const receipt = await first.begin('session', 'mcp.callback', { code: 'private-code', name: 'server' })
    expect(receipt.persistent).toBe(true)
    expect([...stored.keys()][0]).toMatch(/^xcodex-management-intent:v1:[a-f0-9]{64}$/)
    expect([...stored.values()]).toEqual(['original-uuid'])
    expect(JSON.stringify([...stored])).not.toContain('private-code')
    const restored = new ManagedManagementAttempts(() => 'new-uuid', () => storage)
    expect((await restored.begin('session', 'mcp.callback', { name: 'server', code: 'private-code' })).operationId).toBe(receipt.operationId)
    restored.acknowledged(receipt.key)
    expect(stored.size).toBe(0)
  })
  it('keeps an in-page receipt and reports persistence unavailable when browser storage throws', async () => {
    let next = 0
    const attempts = new ManagedManagementAttempts(() => `id-${++next}`, () => { throw new Error('blocked') })
    const first = await attempts.begin('session', 'compact', {})
    expect(first.persistent).toBe(false)
    expect(await attempts.begin('session', 'compact', {})).toEqual(first)
    expect(() => attempts.acknowledged(first.key)).not.toThrow()
  })
  it('refreshes the existing native history binding after rewind without reloading the page', async () => {
    const resync = vi.fn(async () => {}), refreshProjections = vi.fn(async () => {})
    const binding = vi.fn(() => ({ session: { resync } }))
    expect(await refreshManagedNativeHistory({ binding, refreshProjections }, 'session')).toBe(true)
    expect(binding).toHaveBeenCalledWith('session')
    expect(resync).toHaveBeenCalledTimes(1)
    expect(refreshProjections).toHaveBeenCalledWith('session')
    expect(await refreshManagedNativeHistory({ binding: () => ({ session: {} }) }, 'session')).toBe(false)
  })
  it('never offers managed controls for a native conversation', () => {
    expect(render(['compact', 'fork'], false).tree).toBeNull()
  })
  it('shows only provider-advertised operations and requires a real rewind checkpoint', () => {
    const { tree } = render(['context', 'rewind'])
    const names = buttons(tree).flatMap(element => element.children)
    expect(names).toContain('Read context')
    expect(names).not.toContain('Compact')
    expect(names).not.toContain('Fork into new session')
    expect(buttons(tree).find(element => element.children.includes('Rewind to checkpoint'))?.props?.disabled).toBe(true)
    expect(elements(tree).filter(element => element.type === 'select')).toHaveLength(1)
  })
  it('does not accept an empty structured answer or invent launch locations', () => {
    const { tree } = render(['question.answer', 'launch.options', 'launch.select'], true, {
      questions: [{ requestId: 'question', title: 'Choose one', questions: [{ id: 'q1', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] }],
    })
    expect(buttons(tree).find(element => element.children.includes('Submit answer'))?.props?.disabled).toBe(true)
    expect(buttons(tree).some(element => element.children.includes('Save launch selection'))).toBe(false)
    expect(elements(tree).filter(element => element.type === 'input' && element.props?.type === 'radio')).toHaveLength(2)
  })
})
