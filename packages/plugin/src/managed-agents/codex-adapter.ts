import { randomUUID } from 'node:crypto'
import { defaultManagedLaunchRegistry, type ManagedLaunchRegistry } from './launch.js'
import { discoverCodexMethods } from './codex-schema.js'
import { CodexManagement } from './codex-management.js'
import type { ManagedPromptImage } from './management.js'
import { CodexAppServerClient, type CodexAppServerLike } from '../codex/app-server.js'
import type { ManagedAgentAdapter, ManagedAgentConnection, ManagedAgentEmit, ManagedAgentOpen } from './types.js'

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Model selection must use the same complete catalog as discovery. */
async function modelCatalog(client: CodexAppServerLike): Promise<{ data: unknown[] }> {
  const data: unknown[] = [], seen = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < 100; page++) {
    const response = record(await client.call('model/list', cursor ? { cursor } : {}))
    if (!Array.isArray(response.data)) throw new Error('CODEX_MODEL_CATALOG_INVALID')
    data.push(...response.data)
    const next = response.nextCursor
    if (next === undefined || next === null || next === '') return { data }
    if (typeof next !== 'string' || seen.has(next)) throw new Error('CODEX_MODEL_CURSOR_INVALID')
    seen.add(next); cursor = next
  }
  throw new Error('CODEX_MODEL_CATALOG_TOO_LARGE')
}

type PermissionPolicy = { approvalPolicy: 'on-request' | 'never'; sandbox: string; approvalsReviewer: 'user' | 'auto_review' }
function permissionPolicy(mode: string): PermissionPolicy {
  if (mode === 'read-only') return { approvalPolicy: 'on-request', sandbox: 'read-only', approvalsReviewer: 'user' }
  if (mode === 'workspace-write') return { approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'auto_review' }
  if (mode === 'danger-full-access') return { approvalPolicy: 'never', sandbox: 'danger-full-access', approvalsReviewer: 'user' }
  throw new Error('Unsupported permission mode.')
}
function confirmsPermission(response: Record<string, unknown>, policy: PermissionPolicy): boolean {
  const sandbox = typeof response.sandbox === 'string' ? response.sandbox : record(response.sandbox).type
  const expected = { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' }[policy.sandbox]
  return (sandbox === policy.sandbox || sandbox === expected)
    && (response.approvalPolicy ?? response.approval_policy) === policy.approvalPolicy
    && (response.approvalsReviewer ?? response.approvals_reviewer) === policy.approvalsReviewer
}

export class ManagedCodexAdapter implements ManagedAgentAdapter {
  constructor(private readonly createClient?: () => CodexAppServerLike, private readonly launches: ManagedLaunchRegistry = defaultManagedLaunchRegistry) {}

  async open(input: ManagedAgentOpen, emit: ManagedAgentEmit): Promise<ManagedAgentConnection> {
    const acquiredPermission = input.permissionMode ?? 'workspace-write'
    const acquiredPolicy = input.permissionMode === undefined
      ? { approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'user' } as const
      : permissionPolicy(acquiredPermission)
    const launch = this.createClient ? undefined : this.launches.resolve({ sessionId: input.sessionId, agent: 'codex', workspacePath: input.workspacePath, selection: input.launch, previous: input.previousLaunch, previousFingerprint: input.launchFingerprint, resuming: !!input.providerSessionId })
    const binary = launch?.executable('codex') ?? 'codex'
    const client = this.createClient?.() ?? new CodexAppServerClient(binary, undefined,
      executable => launch!.spawn(executable, ['app-server']),
      () => launch!.kind === 'native' ? discoverCodexMethods(binary, { env: launch!.environment() }) : Promise.resolve(new Set<string>()))
    const cwd = launch?.cwd ?? input.workspacePath
    let threadId = input.providerSessionId
    let turnId: string | undefined
    let sending = false
    let active = false
    let ended = false
    let management: CodexManagement | undefined
    let permission = acquiredPermission
    let permissionConfirmed = false
    const promptParts = (text: string, images: ManagedPromptImage[] = []) => {
      if (images.length > 16) throw new Error('Too many images.')
      return [{ type: 'text', text }, ...images.map(image => {
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mimeType) || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data) || image.data.length > 5_600_000) throw new Error('Invalid image.')
        return { type: 'image', url: `data:${image.mimeType};base64,${image.data}` }
      })]
    }
    const approvals = new Map<string, { id: string | number; mcp: boolean }>()
    const announcedTurns = new Set<string>()
    const announceTurn = (id: string) => { if (!announcedTurns.has(id)) { announcedTurns.add(id); emit({ type: 'turn-started', turnId: id }) } }
    const reasoning = new Map<string, string>()
    const pendingText = new Map<string, string>()
    const unsubscribe = client.onInbound(message => {
      const p = record(message.params)
      if (typeof p.threadId === 'string' && p.threadId !== threadId) {
        if (message.kind === 'notification' && management?.ownsChild(p.threadId)) management.observe(message.method, p)
        if (message.kind === 'request') void client.respondError(message.id, -32602, 'Foreign managed thread.').catch(() => undefined)
        return
      }
      if (message.kind === 'request') {
        if (message.method === 'item/tool/requestUserInput' && threadId && p.threadId === threadId && management) {
          try { management.question(message.id, p) } catch { void client.respondError(message.id, -32602, 'Invalid question.').catch(() => undefined) }
          return
        }
        const schema = record(p.requestedSchema)
        const mcp = typeof p.turnId === 'string' && message.method === 'mcpServer/elicitation/request' && record(p._meta).codex_approval_kind === 'mcp_tool_call' && (p.mode === undefined || p.mode === 'form') && (p.requestedSchema == null || (schema.type === 'object' && Object.keys(record(schema.properties)).length === 0))
        if ((!mcp && !['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method)) || !threadId || p.threadId !== threadId) {
          void client.respondError(message.id, -32601, 'Unsupported managed agent request.').catch(() => undefined)
          return
        }
        const requestId = randomUUID()
        approvals.set(requestId, { id: message.id, mcp })
        emit({ type: 'approval', requestId, title: message.method, choices: ['allow-once', 'reject-once', 'cancel'], data: p })
        return
      }
      // Account rate limits are process-wide; all other session frames need
      // the owned thread identity before they reach the mobile event stream.
      if (message.method !== 'account/rateLimits/updated' && p.threadId !== threadId) return
      management?.observe(message.method, p)
      const item = record(p.item)
      const itemId = typeof p.itemId === 'string' ? p.itemId : typeof item.id === 'string' ? item.id : undefined
      if (message.method === 'item/agentMessage/delta' && typeof p.delta === 'string') {
        if (itemId) { pendingText.set(itemId, (pendingText.get(itemId) ?? '') + p.delta); emit({ type: 'text-delta', itemId, text: p.delta }) }
      } else if (message.method === 'item/reasoning/summaryTextDelta' && typeof p.delta === 'string') {
        if (itemId) { reasoning.set(itemId, (reasoning.get(itemId) ?? '') + p.delta); emit({ type: 'reasoning-delta', itemId, text: p.delta }) }
      } else if (message.method === 'item/completed' && item.type === 'agentMessage') {
        const text = typeof item.text === 'string' ? item.text : itemId ? pendingText.get(itemId) : undefined
        if (text) emit({ type: 'text', text, ...(itemId ? { itemId } : {}) })
        if (itemId) pendingText.delete(itemId)
      } else if (message.method === 'item/completed' && item.type === 'reasoning' && itemId) {
        const text = reasoning.get(itemId)
        if (text) emit({ type: 'reasoning', text, itemId })
        reasoning.delete(itemId)
      } else if (['item/started', 'item/completed'].includes(message.method) && itemId && ['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch'].includes(String(item.type))) {
        emit({ type: 'tool', itemId, name: String(item.type), status: message.method === 'item/started' ? 'running' : 'completed', data: item })
      } else if (message.method === 'turn/started') {
        const id = record(p.turn).id
        if (typeof id === 'string') { active = true; turnId = id; announceTurn(id) }
      } else if (message.method === 'turn/completed') {
        const turn = record(p.turn)
        emit({ type: 'turn-completed', ...(typeof turn.id === 'string' ? { turnId: turn.id } : {}), status: turn.status === 'failed' ? 'failed' : turn.status === 'interrupted' ? 'cancelled' : 'completed' })
        turnId = undefined
        active = false
        approvals.clear()
        management?.clearQuestions()
      } else if (message.method === 'error') emit({ type: 'error', code: 'CODEX_TURN_ERROR', message: 'Codex reported an execution error.' })
    })
    const unavailable = client.onUnavailable(code => { ended = true; management?.close(); emit({ type: 'unavailable', code }) })
    try {
      await client.start()
      const response = record(await client.call(input.providerSessionId ? 'thread/resume' : 'thread/start', {
        ...(input.providerSessionId ? { threadId: input.providerSessionId } : {}),
        cwd, ...acquiredPolicy,
        ...(input.model ? { model: input.model } : {}),
      }))
      const id = record(response.thread).id
      if (typeof id !== 'string' || !id || (input.providerSessionId && id !== input.providerSessionId)) throw new Error('Codex returned an invalid session identity.')
      threadId = id
      permissionConfirmed = confirmsPermission(response, acquiredPolicy)
      if (input.permissionMode !== undefined && !permissionConfirmed) throw new Error('CODEX_PERMISSION_ACQUISITION_UNCONFIRMED')
      if (record(record(response.thread).status).type === 'active') active = true
      let defaultModel = typeof response.model === 'string' && response.model
        ? { model: response.model, ...(typeof response.reasoningEffort === 'string' ? { reasoningEffort: response.reasoningEffort } : {}) }
        : undefined
      const methods = await client.discoverSupportedMethods?.().catch(() => new Set<string>())
      if (ended) throw new Error('Codex process ended during initialization.')
      const requestedSettings = () => ({
        model: input.model ?? defaultModel?.model,
        effort: input.reasoningEffort ?? defaultModel?.reasoningEffort,
        approvalPolicy: (permission === acquiredPermission ? acquiredPolicy : permissionPolicy(permission)).approvalPolicy,
        approvalsReviewer: (permission === acquiredPermission ? acquiredPolicy : permissionPolicy(permission)).approvalsReviewer,
        sandboxPolicy: permission === 'read-only' ? { type: 'readOnly' } : permission === 'danger-full-access' ? { type: 'dangerFullAccess' } : { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false },
      })
      management = new CodexManagement({ threadId: id, cwd, client, emit,
        active: () => active || sending, ended: () => ended, settings: requestedSettings, permissionConfirmed: () => permissionConfirmed && permission === acquiredPermission, supportedMethods: methods, restoredChildren: input.restoredChildren })
      let optionRevision = 0
      const setOption = async (key: string, value: string) => {
        if (active || sending) throw new Error('Stop the turn before changing options.')
        if (key === 'model') {
          const catalog = await modelCatalog(client)
          const entry = (Array.isArray(catalog.data) ? catalog.data : []).map(record).find(candidate => candidate.model === value || candidate.id === value)
          if (!entry) throw new Error('Unsupported model.')
          if (ended || active || sending) throw new Error('Codex session changed while selecting a model.')
          optionRevision++
          input.model = value
          if (input.reasoningEffort && !(Array.isArray(entry.supportedReasoningEfforts) ? entry.supportedReasoningEfforts : []).some(effort => record(effort).reasoningEffort === input.reasoningEffort)) input.reasoningEffort = undefined
        }
        else if (key === 'reasoningEffort') {
          const model = input.model ?? defaultModel?.model
          const catalog = await modelCatalog(client)
          const entry = (Array.isArray(catalog.data) ? catalog.data : []).map(record).find(candidate => candidate.model === model || candidate.id === model)
          if (!entry || !(Array.isArray(entry.supportedReasoningEfforts) ? entry.supportedReasoningEfforts : []).some(effort => record(effort).reasoningEffort === value)) throw new Error('Unsupported reasoning effort for this model.')
          if (ended || active || sending) throw new Error('Codex session changed while selecting reasoning effort.')
          optionRevision++
          input.reasoningEffort = value
        }
        else if (key === 'permissionMode') {
          if (!['read-only', 'workspace-write', 'danger-full-access'].includes(value)) throw new Error('Unsupported permission mode.')
          optionRevision++
          permission = value
          permissionConfirmed = false
        } else throw new Error('Unsupported option.')
        if (key === 'model') defaultModel = { model: value, ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}) }
        else if (key === 'reasoningEffort' && defaultModel) defaultModel = { ...defaultModel, reasoningEffort: value }
        emit({ type: 'options', data: { requested: requestedSettings() } })
      }
      return {
        providerSessionId: id,
        get managementOperations() { return [...management!.operations, 'option.set'] as const },
        manage: async (operation, request) => {
          if (operation === 'option.set') {
            if (typeof request.key !== 'string' || typeof request.value !== 'string') throw Object.assign(new Error('Invalid option.'), { definiteRejection: true })
            // The setter validates through read-only catalogs before changing local options.
            const revision = optionRevision
            try { await setOption(request.key, request.value) } catch (error) {
              const failure = error instanceof Error ? error : new Error('Option validation failed.')
              if (optionRevision === revision) Object.assign(failure, { definiteRejection: true })
              throw failure
            }
            return management!.manage('settings', {})
          }
          return management!.manage(operation, request)
        },
        isIdle: () => management!.idle(true),
        steer: methods?.has('turn/steer') ? async ({ messageId, text, images }) => {
          if (ended) throw new Error('Codex process is unavailable.')
          if (!active || !turnId || sending) throw new Error('No confirmed active turn to steer.')
          const expectedTurnId = turnId
          const parts = promptParts(text, images)
          try {
            const response = record(await client.call('turn/steer', { threadId: id, expectedTurnId, clientUserMessageId: messageId, input: parts }))
            if (response.turnId !== expectedTurnId) return { state: 'unknown', reason: 'Codex steering identity was not confirmed.' }
            return { state: 'accepted', providerTurnId: expectedTurnId }
          } catch { return { state: 'unknown', reason: 'Codex steering acknowledgement was not received; do not resend.' } }
        } : undefined,
        get defaultModel() { return defaultModel },
        send: async ({ text, images, messageId }) => {
          if (ended) throw new Error('Codex process is unavailable.')
          if (sending || active) throw new Error('A turn is already running.')
          const parts = promptParts(text, images)
          sending = true
          active = true
          try {
            const result = record(await client.call('turn/start', { threadId, input: parts, clientUserMessageId: messageId, ...requestedSettings() }))
            const next = record(result.turn).id
            if (typeof next !== 'string') return { state: 'unknown', reason: 'Codex did not return a turn identity.' }
            // Notifications may complete the turn before the RPC response arrives.
            if (active) { turnId = next; announceTurn(next) }
            return { state: 'accepted', providerTurnId: next }
          } catch (error) {
            if (['CODEX_UPSTREAM_ERROR', 'CODEX_METHOD_NOT_FOUND'].includes(String(record(error).code))) { active = false; return { state: 'rejected', reason: 'Codex rejected the input.' } }
            return { state: 'unknown', reason: 'Codex submission acknowledgement was not received; do not automatically resend.' } }
          finally { sending = false }
        },
        cancel: async () => { if (turnId) await client.call('turn/interrupt', { threadId, turnId }) },
        approve: async (requestId, choice) => {
          if (!['allow-once', 'reject-once', 'cancel'].includes(choice)) throw new Error('Invalid approval choice.')
          const request = approvals.get(requestId)
          if (request === undefined) throw new Error('Approval is no longer pending.')
          approvals.delete(requestId)
          await client.respond(request.id, request.mcp
            ? choice === 'allow-once' ? { action: 'accept', content: {}, _meta: null } : { action: 'cancel', content: null, _meta: { codex_approval_cancellation_reason: 'user' } }
            : { decision: choice === 'allow-once' ? 'accept' : choice === 'cancel' ? 'cancel' : 'decline' })
        },
        models: () => modelCatalog(client),
        setOption,
        close: async () => { ended = true; unsubscribe(); unavailable(); approvals.clear(); management?.close(); await client.close() },
      }
    } catch (error) { unsubscribe(); unavailable(); await client.close(); throw error }
  }
}
