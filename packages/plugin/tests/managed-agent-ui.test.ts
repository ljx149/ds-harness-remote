import { describe, expect, it, vi } from 'vitest'
import { createManagedAgentUi, type ManagedAgentUiContext } from '../src/client/managed-agent.js'
import type { ClientReact } from '../src/client/types.js'

type Node = { type: unknown; props: Record<string, any>; children: unknown[] }
function harness() {
  const values: any[] = [], deps: unknown[][] = [], effects: Array<() => void> = []
  let index = 0
  const React = {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({ type, props: props ?? {}, children }),
    useState(initial: unknown) {
      const i = index++
      if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial
      return [values[i], (next: any) => { values[i] = typeof next === 'function' ? next(values[i]) : next }]
    },
    useRef(initial: unknown) { const i = index++; return values[i] ??= { current: initial } },
    useEffect(effect: () => void, next: unknown[]) {
      const i = index++
      if (!deps[i] || next.some((value, n) => value !== deps[i][n])) { deps[i] = next; effects.push(effect) }
    },
  } as unknown as ClientReact
  return { React, render(component: () => unknown) { index = 0; const result = component(); effects.splice(0).forEach(effect => effect()); return result } }
}
function nodes(root: unknown): Node[] {
  if (!root || typeof root !== 'object' || !('children' in root)) return []
  const node = root as Node
  return [node, ...node.children.flatMap(nodes)]
}
function button(root: unknown, text: string): Node {
  const result = nodes(root).find(node => node.type === 'button' && node.children.includes(text))
  expect(result, `button ${text}`).toBeDefined()
  return result!
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
function fixture(rows: Record<string, any> = {}, workspaces = [{ workspaceId: 'A', path: '/workspace/A', sessionIds: [] as string[] }]) {
  const call = vi.fn(async (endpoint: string, _request: Record<string, unknown>): Promise<unknown> => {
    if (endpoint === 'managedAgent/agents') return { items: [{ id: 'claude', name: 'Claude Code' }, { id: 'codex', name: 'Codex' }] }
    if (endpoint === 'managedAgent/create') return { sessionId: 'new-managed' }
    return { items: [] }
  })
  const ctx: ManagedAgentUiContext = {
    sessions: { list: { getSnapshot: () => ({ byId: rows }), subscribe: () => () => {} }, refresh: vi.fn(async () => {}) },
    workspaces: { list: { getSnapshot: () => ({ items: workspaces }), subscribe: () => () => {} } },
    call, open: vi.fn(), chinese: false,
  }
  const h = harness(), ui = createManagedAgentUi(h.React, ctx)
  return { ...h, ctx, call, ui, renderNew: () => h.render(() => ui.NewSession({ wide: true })) }
}

describe('desktop managed Agent controls', () => {
  it('keeps native DSH rows without a logo while rendering managed identities', () => {
    for (const id of [undefined, 'dsh', 'deepseek', 'claude', 'codex']) {
      const f = fixture({ S: { id: 'S', projections: { values: { managedAgent: id ? { agentId: id } : undefined } } } })
      const root = f.render(() => f.ui.SessionLogo({ sessionId: 'S' }))
      if (id === 'claude' || id === 'codex') expect(nodes(root).find(n => n.type === 'img')?.props.alt).toBe(id)
      else expect(root).toBeNull()
    }
  })
  it('creates an Agent session in an empty workspace without an existing conversation', async () => {
    const f = fixture()
    let root = f.renderNew()
    expect(button(root, '+ Agent session').props.disabled).toBe(false)
    button(root, '+ Agent session').props.onClick()
    await flush(); root = f.renderNew()
    expect(button(root, 'Claude Code').props.disabled).toBe(false)
    button(root, 'Claude Code').props.onClick()
    await flush(); f.renderNew()
    expect(f.call).toHaveBeenCalledWith('managedAgent/create', { request: { workspaceId: 'A', agentId: 'claude', operationId: expect.any(String) } })
    expect(f.ctx.open).toHaveBeenCalledWith('new-managed')
  })
  it('keeps the entry on discovery failure and reloads on explicit retry', async () => {
    const f = fixture(), original = f.call.getMockImplementation()!
    let fails = true
    f.call.mockImplementation(async (endpoint, payload) => {
      if (endpoint === 'managedAgent/agents' && fails) throw new Error('temporary disconnect')
      return original(endpoint, payload)
    })
    button(f.renderNew(), '+ Agent session').props.onClick()
    await flush(); let root = f.renderNew()
    expect(nodes(root).find(n => n.props.role === 'alert')?.children).toContain('temporary disconnect')
    expect(button(root, '+ Agent session').props.disabled).toBe(false)
    fails = false; button(root, 'Reload Agents').props.onClick()
    f.renderNew(); await flush(); root = f.renderNew()
    expect(button(root, 'Codex').props.disabled).toBe(false)
  })
  it('requires explicit workspace selection when there is no active conversation and multiple directories', async () => {
    const f = fixture({}, [{ workspaceId: 'A', path: '/A', sessionIds: [] }, { workspaceId: 'B', path: '/B', sessionIds: [] }])
    button(f.renderNew(), '+ Agent session').props.onClick()
    await flush(); let root = f.renderNew()
    expect(button(root, 'Codex').props.disabled).toBe(true)
    nodes(root).find(n => n.type === 'select')!.props.onChange({ target: { value: 'B' } })
    root = f.renderNew(); button(root, 'Codex').props.onClick()
    await flush()
    expect(f.call).toHaveBeenCalledWith('managedAgent/create', { request: { workspaceId: 'B', agentId: 'codex', operationId: expect.any(String) } })
  })
  it('reuses the operation id after an ambiguous create failure', async () => {
    const f = fixture(), original = f.call.getMockImplementation()!
    let fails = true
    f.call.mockImplementation(async (endpoint, payload) => {
      if (endpoint === 'managedAgent/create' && fails) throw new Error('lost response')
      return original(endpoint, payload)
    })
    button(f.renderNew(), '+ Agent session').props.onClick(); await flush()
    button(f.renderNew(), 'Codex').props.onClick(); await flush()
    fails = false; button(f.renderNew(), 'Codex').props.onClick(); await flush()
    const calls = f.call.mock.calls.filter(([endpoint]) => endpoint === 'managedAgent/create')
    expect(calls).toHaveLength(2)
    expect(calls[0][1]).toEqual(calls[1][1])
    expect(f.ctx.open).toHaveBeenCalledTimes(1)
  })
})
