import type { ClientReact } from './types.js'
import type { ManagedQuestion } from '../managed-agents/questions.js'
type State = { questions: Array<{ requestId: string; title: string; questions: ManagedQuestion[] }>; queue: Array<{ requestId: string; state: string }>; paused: boolean }
/** A contextual conversation action, not an Agent control panel. No controls when idle. */
export function createChatActions(React: ClientReact, call: (endpoint: string, input: Record<string, unknown>) => Promise<unknown>, chinese: boolean) {
  return function ChatActions({ sessionId }: { sessionId: string }) {
    const [state, setState] = React.useState<State | undefined>(undefined)
    const [answers, setAnswers] = React.useState<Record<string, string[]>>({})
    const [error, setError] = React.useState('')
    const [busy, setBusy] = React.useState(false)
    const [open, setOpen] = React.useState(false)
    const flight = React.useRef(false)
    const activeId = React.useRef(sessionId); activeId.current = sessionId
    React.useEffect(() => {
      let live = true, pending = false, unavailable = false
      setState(undefined); setAnswers({}); setOpen(false); setError(''); setBusy(false)
      const refresh = async () => {
        if (pending || unavailable) return
        pending = true
        try { const value = await call('managedAgent.chatState', { sessionId }) as State; if (live) setState(value) }
        catch (reason) { if (live) { setState(undefined); unavailable = String(reason).includes('MANAGED_SESSION_NOT_FOUND') } }
        finally { pending = false }
      }
      void refresh(); const timer = setInterval(() => { void refresh() }, 1000)
      return () => { live = false; clearInterval(timer) }
    }, [sessionId])
    const question = state?.questions[0]
    React.useEffect(() => { setAnswers({}); setError('') }, [question?.requestId])
    const queueWaiting = !!state?.queue.some(item => item.state === 'queued')
    const uncertain = !!state?.queue.some(item => ['unknown', 'dispatching'].includes(item.state))
    if (!question && !(state?.paused && queueWaiting) && !uncertain) return null
    const run = async (endpoint: string, values: Record<string, unknown>) => {
      if (flight.current) return
      flight.current = true; setBusy(true); setError('')
      try {
        await call(endpoint, { sessionId, ...values })
        const value = await call('managedAgent.chatState', { sessionId }) as State
        if (activeId.current === sessionId) { setState(value); setAnswers({}) }
      } catch (reason) { if (activeId.current === sessionId) setError(reason instanceof Error ? reason.message : String(reason)) }
      finally { flight.current = false; if (activeId.current === sessionId) setBusy(false) }
    }
    return React.createElement('div', { className: 'xcodexChatActions', style: { position: 'relative' } },
      React.createElement('button', { type: 'button', onClick: () => setOpen(value => !value) }, question ? chinese ? '需要你回答' : 'Answer Agent' : chinese ? '待发送消息' : 'Pending messages'),
      open ? React.createElement('div', { role: 'dialog', 'aria-label': chinese ? '对话待办' : 'Conversation actions', style: { position: 'absolute', right: 0, top: '100%', zIndex: 100, width: 'min(360px, 85vw)', maxHeight: '65vh', overflowY: 'auto', padding: 16, background: 'var(--background, #242424)', color: 'var(--foreground, #eee)', border: '1px solid #777', borderRadius: 8 } },
        question ? React.createElement('form', { key: question.requestId, onSubmit: (event: Event) => { event.preventDefault(); void run('managedAgent.answerQuestion', { requestId: question.requestId, answers }) } },
          ...question.questions.map(item => React.createElement('fieldset', { key: item.id, disabled: busy },
            React.createElement('legend', null, item.question),
            ...(item.options ?? []).map(option => React.createElement('label', { key: option.label, style: { display: 'block' } },
              React.createElement('input', { type: item.multiSelect ? 'checkbox' : 'radio', name: item.id, checked: (answers[item.id] ?? []).includes(option.label), onChange: () => setAnswers(previous => ({ ...previous, [item.id]: item.multiSelect ? (previous[item.id] ?? []).includes(option.label) ? previous[item.id]!.filter(value => value !== option.label) : [...(previous[item.id] ?? []), option.label] : [option.label] })) }), option.label)),
            React.createElement('input', { type: item.isSecret ? 'password' : 'text', 'aria-label': item.question, placeholder: chinese ? '输入回答或补充' : 'Enter an answer', value: (answers[item.id] ?? []).filter(value => !item.options?.some(option => option.label === value)).join(', '), onChange: (event: Event) => setAnswers(previous => ({ ...previous, [item.id]: [(event.target as HTMLInputElement).value] })) }))),
          React.createElement('button', { type: 'submit', disabled: busy || question.questions.some(item => !answers[item.id]?.some(value => value.trim())) }, chinese ? '提交回答' : 'Submit answer')) : null,
        uncertain ? React.createElement('p', null, chinese ? '上一条消息的执行结果待确认，后续队列已暂停，避免重复执行。' : 'A previous delivery is uncertain. The queue is paused to prevent duplicate execution.') : null,
        state?.paused && queueWaiting && !uncertain ? React.createElement('button', { type: 'button', disabled: busy, onClick: () => { void run('managedAgent.resumeQueue', {}) } }, chinese ? '继续发送排队消息' : 'Resume queued messages') : null,
        error ? React.createElement('p', { role: 'alert' }, error) : null,
        React.createElement('button', { type: 'button', onClick: () => setOpen(false) }, chinese ? '收起' : 'Close')) : null)
  }
}
