import type { ClientReact } from './types.js'
import type { Translate } from '../client-locale.js'

export function createBrowserLogin(React: ClientReact) {
  return function BrowserLogin(props: {
    control: <T>(endpoint: string, payload?: unknown) => Promise<T>
    onComplete: () => void | Promise<void>
    t: Translate
    disabled?: boolean
    hostOnly?: boolean
    serverUrl?: string
  }) {
    const [flow, setFlow] = React.useState<{ requestId: string; loginUrl: string; expiresAt: number } | undefined>(undefined)
    const [email, setEmail] = React.useState('')
    const [password, setPassword] = React.useState('')
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState<string | undefined>(undefined)
    const run = React.useRef(0)
    const prefix = props.hostOnly ? 'host.browser.' : 'account.browser.'
    const callbacks = React.useRef(props)
    callbacks.current = props
    React.useEffect(() => {
      run.current++
      setFlow(undefined); setBusy(false); setError(undefined)
      return () => { run.current++ }
    }, [props.serverUrl, props.disabled])
    React.useEffect(() => {
      if (!flow) return
      let active = true, timer: ReturnType<typeof setTimeout>, delay = 2000, finished = false
      const poll = async () => {
        try {
          if (Date.now() >= flow.expiresAt) throw Error(props.t('browserLoginExpired'))
          const result = await props.control<{ status: string }>(prefix + 'poll', { requestId: flow.requestId })
          if (!active) return
          if (result.status === 'complete') {
            finished = true
            await callbacks.current.onComplete()
            if (active) setFlow(undefined)
            return
          }
          if (result.status !== 'pending') throw Error(props.t('browserLoginExpired'))
          delay = 2000
        } catch (reason) {
          if (!active) return
          setError(reason instanceof Error ? reason.message : String(reason))
          delay = Math.min(delay * 2, 30000)
          if (Date.now() >= flow.expiresAt) { setFlow(undefined); return }
        }
        if (active) timer = setTimeout(() => void poll(), delay)
      }
      timer = setTimeout(() => void poll(), 2000)
      return () => {
        active = false; clearTimeout(timer)
        if (!finished) void props.control(prefix + 'cancel', { requestId: flow.requestId }).catch(() => {})
      }
    }, [flow, prefix])
    const start = async () => {
      const popup = window.open('about:blank', '_blank')
      if (popup) popup.opener = null
      const generation = ++run.current
      setBusy(true); setError(undefined)
      try {
        const result = await props.control<{ requestId: string; loginUrl: string; expiresAt: number }>(prefix + 'start', {})
        if (generation !== run.current) { popup?.close(); void props.control(prefix + 'cancel', { requestId: result.requestId }).catch(() => {}); return }
        const url = new URL(result.loginUrl)
        const fragment = new URLSearchParams(url.hash.slice(1)); fragment.set('login_provider', 'google'); url.hash = fragment.toString()
        result.loginUrl = url.href
        if (popup) popup.location.replace(result.loginUrl)
        setFlow(result)
      } catch (reason) { popup?.close(); if (generation === run.current) setError(reason instanceof Error ? reason.message : String(reason)) }
      finally { if (generation === run.current) setBusy(false) }
    }
    const signIn = async () => {
      if (busy || flow || props.disabled || !email.trim() || !password) return
      setBusy(true); setError(undefined)
      try {
        if (props.hostOnly) await props.control('host.account.login', { email: email.trim(), password })
        else await props.control('settings.configure', { role: 'client', serverUrl: props.serverUrl || 'https://agent.xcodex.vip', email: email.trim(), password })
        setPassword('')
        await callbacks.current.onComplete()
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason)
        setError(message.includes('AUTH_INVALID') ? props.t('xcodexInvalidLogin') : message)
      } finally { setBusy(false) }
    }
    return React.createElement('div', { className: 'xcodexRemoteBrowserLogin' },
      React.createElement('strong', null, props.t('browserLoginStart')),
      React.createElement('form', { className: 'xcodexRemoteClientLogin', onSubmit: (event: Event) => { event.preventDefault(); void signIn() } },
        React.createElement('input', { type: 'email', required: true, value: email, autoComplete: 'username', placeholder: props.t('account'), 'aria-label': props.t('account'), disabled: busy || !!flow || props.disabled, onChange: (event: Event) => setEmail((event.target as HTMLInputElement).value) }),
        React.createElement('input', { type: 'password', required: true, value: password, autoComplete: 'current-password', placeholder: props.t('password'), 'aria-label': props.t('password'), disabled: busy || !!flow || props.disabled, onChange: (event: Event) => setPassword((event.target as HTMLInputElement).value) }),
        React.createElement('button', { type: 'submit', disabled: busy || !!flow || props.disabled || !email.trim() || !password }, props.t(busy ? 'signingIn' : 'startSignIn'))),
      flow ? React.createElement(React.Fragment, null,
        React.createElement('a', { href: flow.loginUrl, target: '_blank', rel: 'noopener noreferrer' }, props.t('browserLoginOpen')),
        React.createElement('p', { role: 'status' }, props.t('browserLoginWaiting')),
        React.createElement('button', { type: 'button', onClick: () => setFlow(undefined) }, props.t('browserLoginCancel')))
        : React.createElement('button', { type: 'button', disabled: busy || props.disabled, onClick: () => void start() }, props.t(busy ? 'signingIn' : 'xcodexGoogleLogin')),
      error ? React.createElement('p', { role: 'alert', className: 'xcodexRemoteError' }, error) : null)
  }
}
