import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserLogin } from '../src/client/browser-login.js'

import { createRemoteWorkspaceAction } from '../src/client/workspaces.js'
import type { ClientReact, PluginSettingsView } from '../src/client/types.js'

function createTestHarness() {
  let stateSlots: any[] = []
  let stateIndex = 0
  let prevDeps: any[][] = []
  let effectCleanups: (((() => void) | void))[] = []
  let effectIndex = 0

  const React: ClientReact = {
    Fragment: Symbol('Fragment'),
    createElement(type: any, props: any, ...children: any[]) {
      return { type, props: props || {}, children }
    },
    useEffect(effect: any, deps?: any[]) {
      const slot = effectIndex++
      const oldDeps = prevDeps[slot]
      const hasChanged = !oldDeps || !deps || deps.some((d, i) => !Object.is(d, oldDeps[i]))
      if (hasChanged) {
        if (typeof effectCleanups[slot] === 'function') {
          effectCleanups[slot]!()
        }
        prevDeps[slot] = deps || []
        effectCleanups[slot] = effect()
      }
    },
    useCallback(cb: any) { return cb },
    useMemo(factory: any) { return factory() },
    useRef(initial: any) {
      const slot = stateIndex++
      if (stateSlots[slot] === undefined) stateSlots[slot] = { current: initial }
      return stateSlots[slot]
    },
    useState(initial: any) {
      const slot = stateIndex++
      if (stateSlots[slot] === undefined) {
        stateSlots[slot] = typeof initial === 'function' ? initial() : initial
      }
      const setState = (val: any) => {
        stateSlots[slot] = typeof val === 'function' ? val(stateSlots[slot]) : val
      }
      return [stateSlots[slot], setState]
    },
    useSyncExternalStore(subscribe: any, getSnapshot: any) {
      return typeof getSnapshot === 'function' ? getSnapshot() : undefined
    },
  }

  const unmount = () => {
    for (const cleanup of effectCleanups) {
      if (typeof cleanup === 'function') cleanup()
    }
    effectCleanups = []
  }

  const resetRender = () => {
    stateIndex = 0
    effectIndex = 0
  }

  return { React, resetRender, unmount }
}

const findElement = (node: any, predicate: (n: any) => boolean): any => {
  if (!node || typeof node !== 'object') return null
  if (predicate(node)) return node
  if (node.children || Array.isArray(node)) {
    for (const child of Array.isArray(node) ? node : node.children) {
      const found = findElement(child, predicate)
      if (found) return found
    }
  }
  return null
}


afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
const t = ((key: string) => key) as any
function setup(control: any, onComplete = vi.fn(), hostOnly = false) {
  const h = createTestHarness(), Component = createBrowserLogin(h.React)
  const render = () => { h.resetRender(); return Component({ control, onComplete, t, hostOnly, serverUrl: 'https://agent.xcodex.vip' }) }
  return { ...h, render, onComplete }
}
it('submits password through local control, keeps failures visible and clears password on success', async () => {
  const control = vi.fn().mockRejectedValueOnce(Error('AUTH_INVALID')).mockResolvedValue({})
  const h = setup(control)
  let tree = h.render()
  findElement(tree, n => n.props.type === 'email').props.onChange({ target: { value: 'alice@example.com' } })
  findElement(tree, n => n.props.type === 'password').props.onChange({ target: { value: 'test-password' } })
  findElement(h.render(), n => n.type === 'form').props.onSubmit({ preventDefault() {} })
  await new Promise(r => setTimeout(r, 0))
  expect(findElement(h.render(), n => n.props.role === 'alert').children).toContain('xcodexInvalidLogin')
  expect(h.onComplete).not.toHaveBeenCalled()
  findElement(h.render(), n => n.type === 'form').props.onSubmit({ preventDefault() {} })
  await new Promise(r => setTimeout(r, 0))
  expect(control).toHaveBeenLastCalledWith('settings.configure', { role: 'client', serverUrl: 'https://agent.xcodex.vip', email: 'alice@example.com', password: 'test-password' })
  expect(h.onComplete).toHaveBeenCalledOnce()
  expect(findElement(h.render(), n => n.props.type === 'password').props.value).toBe('')
  h.unmount()
})
it('opens Google with a device-bound browser URL and cancels pending flow on unmount', async () => {
  const popup = { opener: {}, location: { replace: vi.fn() }, close: vi.fn() }
  vi.stubGlobal('window', { open: vi.fn(() => popup) })
  const control = vi.fn(async (method: string) => method.endsWith('start') ? { requestId: 'request', loginUrl: 'https://agent.xcodex.vip/app/remote#device_login=browser-proof', expiresAt: Date.now() + 600000 } : {})
  const h = setup(control)
  findElement(h.render(), n => n.type === 'button' && n.children.includes('xcodexGoogleLogin')).props.onClick()
  await new Promise(r => setTimeout(r, 0))
  const tree = h.render()
  const opened = new URL(popup.location.replace.mock.calls[0]![0])
  expect(new URLSearchParams(opened.hash.slice(1)).get('device_login')).toBe('browser-proof')
  expect(new URLSearchParams(opened.hash.slice(1)).get('login_provider')).toBe('google')
  expect(findElement(tree, n => n.props.type === 'password').props.disabled).toBe(true)
  h.unmount()
  expect(control).toHaveBeenLastCalledWith('account.browser.cancel', { requestId: 'request' })
})
