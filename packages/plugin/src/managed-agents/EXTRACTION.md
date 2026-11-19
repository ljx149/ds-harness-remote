# Orca Agent management extraction

Source: `/root/joseph/orca`, commit `81c1f25fe98647365d226aed0254e888d2aa2a98`.
License: MIT, Copyright (c) 2026 Lovecast Inc.; full notice in this directory and packaged root `ORCA-LICENSE`.

This is a Host-local subsystem: it imports no Orca application, desktop IPC, or remote Orca daemon. Closing a viewer or revoking one device does not own or stop an Agent process. Only explicit session/Host shutdown closes a managed process.

## Source inventory and migration coverage

| Orca source | Plugin implementation | Coverage |
| --- | --- | --- |
| `shared/agent-session/capabilities/agent-session-capabilities.ts` | `capabilities.ts` | Copied contract; advertised capabilities restricted to actually implemented methods |
| `main/native-chat/agent-session-wire/providers/structured-agent-registry.ts` | `registry.ts` | Adapted registry and capability implementation validation |
| `.../structured-agent-session-adapter-router.ts`, `.../structured-agent-session-acquisition-route.ts` | `runtime.ts` | Adapted Host-owned single-flight acquisition, provider ownership, workspace ownership and close-during-start handling; not Orca's durable lease implementation |
| `main/claude/sdk-transport/claude-agent-sdk-user-message-queue.ts` | `claude-message-queue.ts` | Original queue including unwritten vs ambiguous write classification |
| `main/claude/sdk-transport/claude-agent-sdk-control-requests.ts` | `claude-controls.ts` | Adapted full SDK control surface: options, model catalog, interruption, background tasks, MCP and naming; removed Orca diagnostic dependency; not all controls exposed in DSH UI yet |
| `main/claude/claude-stream-json-connection.ts`, `structured/launch/claude-structured-launch-resolution.ts` | `claude-adapter.ts` | Adapted native SDK query lifecycle, user/project/local configuration sources, fixed resume identity, approvals, final message projection and startup bound |
| `main/codex/structured/session-lifecycle/codex-structured-session-adapter.ts` | `codex-adapter.ts` | Native app-server lifecycle, own thread start/resume, model/effort, approvals and message projection; reuses Remote's tested JSON-RPC transport rather than copying Orca's transport |
| `native-chat/agent-session-journal`, `agent-session-wire/delivery`, `recovery`, `host` | Host managed backend/session store | Durable session/message identity, receipts and replay are integrated separately; no imported native transcript scan |
| `provider-process`, `daemon`, `wsl-guest`, SSH execution and PTY resurrection | Not ported | Initial native Host process execution only; no claimed cross-process task survival or Orca daemon compatibility |
| Account vault/profile router, usage budgets, native conversation forks/rewind, background-work roster, skills/MCP management UI | Not yet integrated | Existing local Agent configuration is retained; no account-vault migration and no unsupported capability advertised |

This is not a claim that all Orca management features have been migrated. The entire subsystem was inventoried; the common registration, execution, configuration, approval and lifecycle boundary is extracted first. Advanced provider controls are available in the copied Claude control surface, but need explicit native UI/permission integration before being exposed remotely.

## Execution contract

- `ManagedAgentRuntime.open` takes only a Host-validated workspace path and managed session identity. The caller persists `providerSessionId`; resume uses exactly that ID, never latest/resume-all or history enumeration.
- Native Claude uses the pinned `@anthropic-ai/claude-agent-sdk@0.3.319` and installed `claude`, not `claude-agent-acp`. `ManagedAcpAdapter` is an optional extension seam only.
- Native Codex uses installed `codex app-server`, keeps local model/provider configuration and defaults to workspace-write/on-request permission.
- Accepted send means dispatch acceptance, never turn completion. The Host must persist an operation receipt before dispatch. An unknown write cannot be retried automatically.
- Output currently publishes completed assistant blocks/items rather than every text delta. Reasoning and tool events remain distinct types. This avoids duplicate text in native history without replacing partially streamed rows.
- Approval choices are single-use. Native providers expose `allow-once`, `reject-once`, `cancel`; unknown/expired IDs reject. Device authorization belongs to the Host RPC boundary.
- Runtime unavailable removes the live route so recovery may resume the stored provider ID. There is no claim of continuing an in-flight task after Host process death.

## Validation on 2026-11-19

- Linux, Node 22.22.0: focused lifecycle/approval/queue tests and TypeScript check.
- Bundled runtime imported from `/tmp` outside the repository; real installed Claude initialized with no prompt and closed successfully. No model request was sent.
- Installed Codex 0.153.4 app-server exits before handshake with the default read-only home. A second isolated smoke used a fresh empty temporary `CODEX_HOME`, no copied credentials, and child-local environment only: native initialization/thread creation succeeded and the captured child exited on close. This does not validate the user's configured model or actual Agent replies.
- Real Claude child identity was also captured in an isolated SDK smoke; initialization succeeded and the child exited after close. No prompt or model request was sent.
- A subsequent bounded real-reply smoke used the existing local Claude configuration and a temporary empty work directory: the new adapter accepted the prompt, received a completed turn, and matched the required `MANAGED_AGENT_OK` reply in 9.827 seconds, without tool requests. `close()` completed and the smoke process exited. The matching Codex test deliberately retained the existing configuration/home and failed before dispatch with `CODEX_APP_SERVER_EXITED` (57 ms); the empty-home initialization test is not a substitute for this blocked real-reply test.
- Real model responses, macOS/Windows execution, native UI, phone/tablet reconnect and device revocation acceptance must be verified by the integration owner; unit tests do not substitute for those checks.
