# Codex management extraction

Source: Orca commit `81c1f25fe98647365d226aed0254e888d2aa2a98`, MIT (see `ORCA-LICENSE`). Adapted for the existing Host-owned app-server transport; no Orca desktop bridge, account copying, or global history import.

Reference source modules:

- `src/main/codex/structured/threads/codex-structured-rewind.ts`: paginated owned-thread preflight, `thread/revert` (not legacy rollback), retained-turn identity.
- `src/main/codex/codex-conversation-copy.ts`: `thread/fork`, checkpoint boundary, `excludeTurns`.
- `src/main/codex/structured/threads/codex-structured-thread-goal.ts` and `catalog/codex-structured-applied-settings.ts`: goals and settings acknowledgment.
- `src/main/codex/structured/session-lifecycle/codex-session-mcp.ts`, `codex-mcp-server-status.ts`, `codex-mcp-enabled-write.ts`, `codex-mcp-sign-in-callback.ts`: MCP status, scoped reload, user-owned enable flags, OAuth and matched loopback callback.
- `src/main/codex/structured/background-work/codex-background-terminals.ts`, `codex-background-task-frames.ts`, `codex-subagent-activity.ts`: bounded terminal listing, confirmed stops, parent-announced child identity.
- `src/main/codex/structured/prompts/codex-prompt-registry.ts`, `codex-structured-prompt-replies.ts`, `codex-mcp-tool-approval.ts`: questions and tool approvals.
- `src/main/codex/structured/turns/codex-structured-turn-steer.ts`: active-turn-fenced steering.

## Implemented boundary

`codex-management.ts` provides current-thread state/checkpoints, measured context usage, account rate limits, skills discovery, model/effort/permission options, native rename, compact admission, rewind/fork, goal read/set/clear, MCP list/reload/toggle/OAuth/callback, structured question answers, terminal status/stops, and observed subagent state/stops. `codex-adapter.ts` provides streaming deltas, inline images and guarded steering. Completion events remain separate from deltas so the journal can commit one final message.

Only provider method names declared by the installed CLI schema are advertised. The optional injectable `discoverSupportedMethods` on the app-server transport runs the documented `codex app-server generate-json-schema --out ...` using the same resolved binary, with a five-second timeout, bounded output/file count/size, and a private temporary directory that is removed. Results are process-cached by binary path/mtime/size. Failure means capability unknown, never a fabricated version or successful operation. Explicit method refusal removes support for that live connection. Source: [official app-server schema documentation](https://developers.openai.com/codex/app-server#message-schema).

Rewind/fork only query the connection's owned thread; callers cannot select another provider thread. Backend must intersect listed checkpoints with the plugin journal and persist mutation receipts. Accepted input emits a deduplicated `turn-started` when needed. Backend supplies `operationId`; an ambiguous mutation is never automatically repeated. Backend also owns conversation-history truncation/copy and new fork ownership registration. A fork result is a provider identity, not an invitation to import all provider history.

Goal activation waits for both the settings RPC and matching `thread/settings/updated` model/effort evidence. Replacing a live goal requires an explicit clear first; submitting its identical objective changes status without resetting goal identity. Pausing does not install new model settings. Unknown settings do not start a goal. Token budgets and custom compact instructions are rejected because this extraction does not prove these controls against the current schema. MCP callbacks must match the pending OAuth server, expiry, loopback origin/path and state; redirects are not followed. MCP toggles only touch the named server declared in the user configuration.

## Deliberate unsupported cases and remaining work

- `tasks.background` is not exposed: no equivalent Codex operation was established in the inspected Orca source. Runtime terminal tracking and subagent interruption are distinct operations.
- Generic MCP elicitation forms are rejected. Empty-schema MCP tool approval and `item/tool/requestUserInput` questions are supported; approval-for-session is not offered.
- Child identity/activity is reconstructed from live parent spawn events and Host-owned journal `restoredChildren` entries. Only parent chains rooted at this exact provider thread are admitted. Restored activity starts unknown and is refreshed using owned child metadata and the latest child turn; no global thread enumeration or history import occurs.
- Subagent stop includes the registered descendant closure, interrupts each confirmed live turn, terminates only terminal process IDs listed by each owned child thread, and confirms metadata idle plus empty terminal list. It does not kill OS processes or claim success merely from an interrupt acknowledgment.
- Context usage is unavailable until a provider usage notification arrives; cumulative account tokens are not misreported as current context.
- Permission changes apply to the next normal turn. Goal settings installation confirms model/effort (matching the extracted Orca helper); goal activation requires a matching acquired permission readback; changing local permission invalidates that proof until the Host reopens the owned thread. Launch profiles, account homes and mapped workspaces use the shared Host launch registry. Non-native schema capability discovery remains unknown unless the owned executor supplies a schema mechanism.
- Empty/legacy histories cannot be rewound or forked through this checkpoint path. No global rollout scanner or history import fallback is used.
- The live schema verifies method presence, not every optional parameter on every CLI version. Provider refusal is propagated; it must not be turned into a success by the UI.

## Validation

`tests/managed-codex-controls.test.ts` covers capability narrowing, images/steer/deltas and ownership, complete question answers, checkpoint ownership, unknown fork non-replay, fork identity, context usage, goal settings, terminal stop evidence, subagent scoping, OAuth callback constraints, schema parsing, restored descendant ownership, and definite-rejection versus unknown-mutation classification. These tests were authored without running CLI processes or tests on the production machine; the coordinating agent runs bounded serial checks. No claim of real Codex runtime acceptance is made here.

## Permission reacquisition gap

Orca's `shared/agent-launch/permissions/codex-permission-policy.ts` uses three explicit policies: Ask = read-only/on-request/user reviewer, Auto = workspace-write/on-request/auto_review, Full Access = danger-full-access/never/user reviewer. `structured/threads/codex-structured-thread-open.ts` applies the policy at thread start/resume; `structured/turns/codex-structured-turn-permission.ts` and `native-chat/agent-session-wire/delivery/structured-agent-session-input-handover.ts` coordinate permission changes with acquisition generation, session fence, cancellation and stop confirmation. Its goal helper installs only model/effort, relying on that acquired policy.

An initial open without an explicit permission preserves workspace-write/on-request/user and still works on older CLIs that do not report permissions. Such an unconfirmed policy cannot activate goals. Explicit `permissionMode` opens/resumes use the complete policy: read-only → Ask, workspace-write → Auto, danger-full-access → Full Access. They require the actual top-level response's approval policy, approvals reviewer, and sandbox type to match; absent or mismatched readback closes the connection and fails. No RPC acknowledgment alone is treated as proof.

The Host validates idle/no-background-work, persists the desired selection, closes the old acquisition, and reopens the exact owned thread with `permissionMode`. A local permission change immediately invalidates goal permission proof. Once the new acquisition is confirmed, non-default goals are allowed and still wait for matching model/effort settings acknowledgment. No provider history is imported during reacquisition.

## Coordinated real-runtime verification

The coordinating run on Linux / Node 24.9.0 / Codex 0.153.4 completed a real turn, owned checkpoint/context/commands/settings reads, a fork of that isolated test thread, and confirmed close. Initial pre-handshake failure was the restricted read-only CLI state directory; the same configured CLI succeeded when its test process could write its own runtime state. Full advanced controls and desktop/mobile acceptance remain separate; see `docs/design/orca-management-0.8-validation.md`.
