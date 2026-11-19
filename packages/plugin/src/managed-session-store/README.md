# Managed session persistence

This store contains **only sessions created through this plugin**. It never scans
provider directories or imports external agent history. Trusted host code supplies
`{ownerId, hostId, workspaceId}` and the absolute workspace path. An RPC caller must
not choose its own owner or host. Device authorization is checked by the transport;
a subscription to this host-only store does not grant remote access.

## Required execution order

1. `createSession` persists a stable local ID, deduplicated by creation operation ID
   within the trusted scope. A changed request under the same ID is rejected.
2. Before provider session creation or a turn, call `beginOperation`. Only execute
   external effects when `execute === true`. Operation IDs must survive retries.
3. `bindProviderSession` records the provider ID once it exists; binding cannot
   subsequently point at another provider conversation.
4. Persist user/agent/tool events with stable event IDs using `appendEvent`.
   Repeated IDs return the original event; changed contents are rejected.
5. Call `completeOperation` with a JSON receipt. Unknown provider delivery is not a
   failure that can be retried: query/reconcile the original operation instead.
6. Subscribers receive only committed events. After reconnect read from the last
   committed sequence using `readEvents`. Subscribe before replay and deduplicate
   sequence numbers to close the replay/live handoff race.

Disconnecting/revoking a device removes its subscriptions and transport access. It
must not close the shared store or stop provider processes. Explicit user cancel
is a separate managed operation.

## Persistence boundaries

Snapshots are private files (0600), atomically renamed after file fsync followed
by directory fsync. Events are logically append-only; snapshots rewrite their
existing prefix unchanged. No event compaction/deletion is currently provided.
A snapshot is capped at 64 MiB and an individual payload at 1 MiB; reaching capacity
fails before committing and requires an explicit retention/storage upgrade.
This baseline favors correctness over very large histories and is not a claim of
unbounded storage or high-throughput streaming-token performance. Coalesce tiny
provider deltas before writing when integrating.

A unique immutable PID/UUID holder is published before other holders are scanned.
Any live holder causes a competing opener to fail closed. Dead holders can safely
be deleted by their unique names, allowing crash recovery without an unlink race
on a reusable shared lock. PID reuse can conservatively block recovery. Local
Linux filesystems are the supported durability target; NFS/shared multi-host
storage and Windows directory-fsync behavior have not been validated.

On restart all pending operations become `unknown`; they never auto-execute.
A write failure poisons the open instance: close/reopen it and reconcile durable
state before doing more external work. Malformed snapshots are rejected rather
than silently replaced with an empty database. Never place secrets, tokens or
environment configuration in event payloads or session metadata.
