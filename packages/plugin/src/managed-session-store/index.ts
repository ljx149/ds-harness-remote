import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';

/** Scope MUST come from the authenticated host, never directly from an RPC body. */
export interface ManagedSessionScope { ownerId: string; hostId: string; workspaceId: string }
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface ManagedSession extends ManagedSessionScope {
  id: string; agentId: string; providerId: string; providerSessionId: string | null;
  workspacePath: string; title: string; createdAt: number; updatedAt: number;
  archived?: boolean;
}
export interface ManagedEvent { sequence: number; eventId: string; type: string; payload: JsonValue; createdAt: number }
export interface OperationReceipt {
  operationId: string; kind: string; fingerprint: string;
  status: 'pending' | 'unknown' | 'completed' | 'failed'; result?: JsonValue;
}
interface Row { session: ManagedSession; events: ManagedEvent[]; operations: OperationReceipt[]; createOperationId: string; createFingerprint: string }
interface State { version: 1; rows: Row[] }
const identifier = z.string().min(1).max(512);
const jsonValue: z.ZodType<JsonValue> = z.lazy(() => z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(jsonValue), z.record(z.string(), jsonValue)]));
const schema = z.object({ version: z.literal(1), rows: z.array(z.object({
  session: z.object({ id: identifier, ownerId: identifier, hostId: identifier, workspaceId: identifier,
    agentId: identifier, providerId: identifier, providerSessionId: identifier.nullable(), workspacePath: identifier,
    title: z.string().max(1024), createdAt: z.number().finite(), updatedAt: z.number().finite() }).strict(),
  events: z.array(z.object({ sequence: z.number().int().positive(), eventId: identifier, type: identifier, payload: jsonValue, createdAt: z.number().finite() }).strict()),
  operations: z.array(z.object({ operationId: identifier, kind: identifier, fingerprint: identifier,
    status: z.enum(['pending', 'unknown', 'completed', 'failed']), result: jsonValue.optional() }).strict()),
  createOperationId: identifier, createFingerprint: identifier,
}).strict()) }).strict();
const MAX_PAYLOAD = 1024 * 1024;
const MAX_STATE = 64 * 1024 * 1024;
function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k]!)}`).join(',')}}`;
  return JSON.stringify(value);
}
function fingerprint(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded) > MAX_PAYLOAD) throw new Error('MANAGED_PAYLOAD_TOO_LARGE');
  // Validate exact JSON rather than silently allowing undefined, Date, functions or non-finite numbers.
  const parsed = jsonValue.parse(value);
  return createHash('sha256').update(canonical(parsed)).digest('hex');
}
function scopeMatches(a: ManagedSessionScope, b: ManagedSessionScope): boolean {
  return a.ownerId === b.ownerId && a.hostId === b.hostId && a.workspaceId === b.workspaceId;
}
function validateScope(scope: ManagedSessionScope): void {
  identifier.parse(scope.ownerId); identifier.parse(scope.hostId); identifier.parse(scope.workspaceId);
}
function plainFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('MANAGED_UNSAFE_FILE');
}

/** Single-process writer, local filesystem only. Events are logically append-only.
 * Each mutation commits the entire bounded snapshot through fsync + atomic rename.
 * Failure poisons this instance: callers must reopen and reconcile, never repeat effects.
 * No credential/environment values belong in metadata or event payloads.
 */
export class ManagedSessionStore {
  private state: State = { version: 1, rows: [] };
  private closed = false;
  private poisoned = false;
  private readonly listeners = new Set<(session: ManagedSession, event: ManagedEvent) => void>();
  private readonly file: string;
  private readonly lock: string;
  private readonly lockToken = randomUUID();

  static open(directory: string): ManagedSessionStore { return new ManagedSessionStore(directory); }
  private constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('MANAGED_UNSAFE_DIRECTORY');
    this.file = join(directory, 'sessions.json'); this.lock = join(directory, `writer-${process.pid}-${this.lockToken}.lock`);
    // Publish an immutable unique holder before scanning. An overlapping opener
    // either sees us or was already published and will be seen by us. Dead holders
    // can be removed safely because their names are never reused (no unlink race).
    const fd = openSync(this.lock, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token: this.lockToken })); fsyncSync(fd); }
    finally { closeSync(fd); }
    try {
      for (const name of readdirSync(directory)) {
        if (!name.startsWith('writer-') || !name.endsWith('.lock') || join(directory, name) === this.lock) continue;
        const match = /^writer-(\d+)-[0-9a-f-]{36}\.lock$/.exec(name);
        if (!match) throw new Error('MANAGED_WRITER_LOCK_INVALID');
        const pid = Number(match[1]);
        let exited = false;
        try { process.kill(pid, 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') exited = true; }
        if (!exited) throw new Error('MANAGED_WRITER_BUSY');
        try { unlinkSync(join(directory, name)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      if (existsSync(this.file)) {
        plainFile(this.file);
        if (lstatSync(this.file).size > MAX_STATE) throw new Error('MANAGED_STORE_TOO_LARGE');
        this.state = schema.parse(JSON.parse(readFileSync(this.file, 'utf8')));
        const ids = new Set<string>();
        const createIds = new Set<string>();
        for (const row of this.state.rows) {
          const createId = JSON.stringify([row.session.ownerId, row.session.hostId, row.session.workspaceId, row.createOperationId]);
          if (createIds.has(createId) || ids.has(row.session.id) || row.events.some((event, i) => event.sequence !== i + 1) ||
            new Set(row.events.map(e => e.eventId)).size !== row.events.length ||
            new Set(row.operations.map(o => o.operationId)).size !== row.operations.length) throw new Error('MANAGED_STORE_CORRUPT');
          ids.add(row.session.id); createIds.add(createId);
          for (const operation of row.operations) if (operation.status === 'pending') operation.status = 'unknown';
        }
        this.persist(this.state);
      }
    } catch (error) { this.releaseLock(); throw error; }
  }
  close(): void { if (!this.closed) { this.closed = true; this.listeners.clear(); this.releaseLock(); } }
  private releaseLock(): void {
    if (existsSync(this.lock) && JSON.parse(readFileSync(this.lock, 'utf8')).token === this.lockToken) unlinkSync(this.lock);
  }
  private assertOpen(): void { if (this.closed || this.poisoned) throw new Error('MANAGED_STORE_UNAVAILABLE'); }
  private persist(next: State): void {
    const bytes = JSON.stringify(next);
    if (Buffer.byteLength(bytes) > MAX_STATE) throw new Error('MANAGED_STORE_FULL');
    const temporary = join(this.directory, `sessions.${randomUUID()}.tmp`);
    try {
      const fd = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, this.file);
      const dir = openSync(this.directory, 'r');
      try { fsyncSync(dir); } finally { closeSync(dir); }
      this.state = next;
    } catch (error) { this.poisoned = true; throw error; }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  private row(scope: ManagedSessionScope, id: string, state = this.state): Row {
    this.assertOpen(); validateScope(scope);
    const row = state.rows.find(r => r.session.id === id && scopeMatches(r.session, scope));
    if (!row) throw new Error('MANAGED_SESSION_NOT_FOUND');
    return row;
  }
  createSession(scope: ManagedSessionScope, input: { operationId: string; agentId: string; providerId: string; workspacePath: string; title?: string }): ManagedSession {
    this.assertOpen(); validateScope(scope); identifier.parse(input.operationId); identifier.parse(input.agentId); identifier.parse(input.providerId);
    identifier.parse(input.workspacePath);
    if (!isAbsolute(input.workspacePath)) throw new Error('MANAGED_WORKSPACE_PATH_INVALID');
    const title = z.string().max(1024).parse(input.title ?? 'New conversation');
    const hash = fingerprint({ agentId: input.agentId, providerId: input.providerId, workspacePath: input.workspacePath, title });
    const old = this.state.rows.find(r => scopeMatches(r.session, scope) && r.createOperationId === input.operationId);
    if (old) { if (old.createFingerprint !== hash) throw new Error('MANAGED_OPERATION_CONFLICT'); return structuredClone(old.session); }
    const now = Date.now();
    const session: ManagedSession = { ownerId: scope.ownerId, hostId: scope.hostId, workspaceId: scope.workspaceId, id: randomUUID(), agentId: input.agentId, providerId: input.providerId,
      providerSessionId: null, workspacePath: input.workspacePath, title, createdAt: now, updatedAt: now };
    const next = structuredClone(this.state);
    next.rows.push({ session, events: [], operations: [], createOperationId: input.operationId, createFingerprint: hash });
    this.persist(next); return structuredClone(session);
  }
  listSessions(scope: ManagedSessionScope): ManagedSession[] {
    this.assertOpen(); validateScope(scope);
    return this.state.rows.filter(r => scopeMatches(r.session, scope)).map(r => this.sessionView(r));
  }
  private sessionView(row: Row): ManagedSession {
    const archive = row.operations.filter(operation => operation.kind === 'archive-state' && operation.status === 'completed').at(-1);
    return { ...structuredClone(row.session), archived: (archive?.result as { archived?: boolean } | undefined)?.archived === true };
  }
  getSession(scope: ManagedSessionScope, id: string): ManagedSession { return this.sessionView(this.row(scope, id)); }
  setArchived(scope: ManagedSessionScope, id: string, archived: boolean): void {
    const next = structuredClone(this.state); const row = this.row(scope, id, next);
    if (this.sessionView(row).archived === archived) return;
    // Reuse the v1 operation envelope: older plugin versions can still read the
    // snapshot, and archive state never appears as a chat message.
    row.operations.push({ operationId: randomUUID(), kind: 'archive-state', fingerprint: fingerprint({ archived }), status: 'completed', result: { archived } });
    this.persist(next);
  }
  renameSession(scope: ManagedSessionScope, id: string, title: string): void {
    z.string().max(1024).parse(title);
    const next = structuredClone(this.state); const row = this.row(scope, id, next);
    row.session.title = title; row.session.updatedAt = Date.now(); this.persist(next);
  }
  bindProviderSession(scope: ManagedSessionScope, id: string, providerSessionId: string): void {
    identifier.parse(providerSessionId);
    const next = structuredClone(this.state); const row = this.row(scope, id, next);
    if (row.session.providerSessionId && row.session.providerSessionId !== providerSessionId) throw new Error('MANAGED_PROVIDER_SESSION_CONFLICT');
    row.session.providerSessionId = providerSessionId; row.session.updatedAt = Date.now(); this.persist(next);
  }
  /** Compare-and-swap provider identity and receipt in ONE durable snapshot.
   * A successful provider fork must never resume the old transcript on restart. */
  commitProviderReplacement(scope: ManagedSessionScope, id: string, operationId: string, expected: string, replacement: string, result: JsonValue, journalEntry?: { eventId: string; payload: JsonValue }): void {
    identifier.parse(replacement); fingerprint(result);
    const next = structuredClone(this.state); const row = this.row(scope, id, next);
    const receipt = row.operations.find(o => o.operationId === operationId);
    if (!receipt || receipt.kind !== 'manage:rewind' || receipt.status !== 'pending') throw new Error('MANAGED_OPERATION_CONFLICT');
    if (row.session.providerSessionId !== expected) throw new Error('MANAGED_PROVIDER_SESSION_CONFLICT');
    row.session.providerSessionId = replacement; row.session.updatedAt = Date.now();
    receipt.status = 'completed'; receipt.result = structuredClone(result);
    if (journalEntry) {
      identifier.parse(journalEntry.eventId); fingerprint(journalEntry.payload);
      if (row.events.some(event => event.eventId === journalEntry.eventId)) throw new Error('MANAGED_EVENT_CONFLICT');
      row.events.push({ eventId: journalEntry.eventId, type: 'native', payload: structuredClone(journalEntry.payload), sequence: row.events.length + 1, createdAt: Date.now() });
    }
    this.persist(next);
    if (journalEntry) for (const listener of this.listeners) { try { listener(structuredClone(row.session), structuredClone(row.events.at(-1)!)); } catch { /* durable replay remains authoritative */ } }
  }
  /** Publish fork identity, inherited plugin journal and parent receipt together.
   * A crash must never leave a visible unbound child that can create a second thread. */
  commitFork(scope: ManagedSessionScope, id: string, operationId: string, providerSessionId: string, entries: Array<{ eventId: string; payload: JsonValue }>): ManagedSession {
    identifier.parse(providerSessionId);
    const next = structuredClone(this.state); const parent = this.row(scope, id, next);
    const receipt = parent.operations.find(o => o.operationId === operationId);
    if (!receipt || receipt.kind !== 'manage:fork' || receipt.status !== 'pending' || parent.session.providerSessionId === providerSessionId) throw new Error('MANAGED_OPERATION_CONFLICT');
    const now = Date.now();
    const session: ManagedSession = { ...parent.session, id: randomUUID(), providerSessionId, createdAt: now, updatedAt: now };
    const events: ManagedEvent[] = entries.map((entry, index) => {
      identifier.parse(entry.eventId); fingerprint(entry.payload);
      return { eventId: entry.eventId, type: 'native', payload: structuredClone(entry.payload), sequence: index + 1, createdAt: now };
    });
    if (new Set(events.map(event => event.eventId)).size !== events.length) throw new Error('MANAGED_EVENT_CONFLICT');
    const createOperationId = `fork:${createHash('sha256').update(JSON.stringify([id, operationId])).digest('hex')}`;
    next.rows.push({ session, events, operations: [], createOperationId, createFingerprint: fingerprint({ agentId: session.agentId, providerId: session.providerId, workspacePath: session.workspacePath, title: session.title }) });
    receipt.status = 'completed'; receipt.result = { sessionId: session.id, providerSessionId };
    this.persist(next);
    const last = events.at(-1);
    if (last) for (const listener of this.listeners) { try { listener(structuredClone(session), structuredClone(last)); } catch { /* durable replay remains authoritative */ } }
    return structuredClone(session);
  }
  beginOperation(scope: ManagedSessionScope, id: string, input: { operationId: string; kind: string; input: JsonValue }): { execute: boolean; receipt: OperationReceipt } {
    identifier.parse(input.operationId); identifier.parse(input.kind);
    const hash = fingerprint({ kind: input.kind, input: input.input });
    const next = structuredClone(this.state); const row = this.row(scope, id, next);
    const previous = row.operations.find(o => o.operationId === input.operationId);
    if (previous) {
      if (previous.fingerprint !== hash) throw new Error('MANAGED_OPERATION_CONFLICT');
      return { execute: false, receipt: structuredClone(previous) };
    }
    const receipt: OperationReceipt = { operationId: input.operationId, kind: input.kind, fingerprint: hash, status: 'pending' };
    row.operations.push(receipt); this.persist(next);
    return { execute: true, receipt: structuredClone(receipt) };
  }
  completeOperation(scope: ManagedSessionScope, id: string, operationId: string, status: 'completed' | 'failed', result: JsonValue): OperationReceipt {
    fingerprint(result);
    const next = structuredClone(this.state); const row = this.row(scope, id, next);
    const receipt = row.operations.find(o => o.operationId === operationId);
    if (!receipt) throw new Error('MANAGED_OPERATION_NOT_FOUND');
    if (receipt.status === 'completed' || receipt.status === 'failed') {
      if (receipt.status !== status || fingerprint(receipt.result!) !== fingerprint(result)) throw new Error('MANAGED_OPERATION_CONFLICT');
      return structuredClone(receipt);
    }
    receipt.status = status; receipt.result = structuredClone(result); this.persist(next); return structuredClone(receipt);
  }
  listOperations(scope: ManagedSessionScope, id: string): OperationReceipt[] {
    return structuredClone(this.row(scope, id).operations);
  }
  getOperation(scope: ManagedSessionScope, id: string, operationId: string): OperationReceipt | null {
    return structuredClone(this.row(scope, id).operations.find(o => o.operationId === operationId) ?? null);
  }
  appendEvent(scope: ManagedSessionScope, id: string, input: { eventId: string; type: string; payload: JsonValue }): ManagedEvent {
    identifier.parse(input.eventId); identifier.parse(input.type); fingerprint(input.payload);
    const next = structuredClone(this.state); const row = this.row(scope, id, next);
    const previous = row.events.find(e => e.eventId === input.eventId);
    if (previous) {
      if (previous.type !== input.type || fingerprint(previous.payload) !== fingerprint(input.payload)) throw new Error('MANAGED_EVENT_CONFLICT');
      return structuredClone(previous);
    }
    const event: ManagedEvent = { eventId: input.eventId, type: input.type, payload: structuredClone(input.payload), sequence: row.events.length + 1, createdAt: Date.now() };
    row.events.push(event); row.session.updatedAt = event.createdAt; this.persist(next);
    for (const listener of this.listeners) { try { listener(structuredClone(row.session), structuredClone(event)); } catch { /* durable event remains available through cursor replay */ } }
    return structuredClone(event);
  }
  readEvents(scope: ManagedSessionScope, id: string, afterSequence = 0, limit = 100): { events: ManagedEvent[]; nextSequence: number; hasMore: boolean } {
    const row = this.row(scope, id);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || afterSequence > row.events.length || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('MANAGED_CURSOR_INVALID');
    const events = structuredClone(row.events.slice(afterSequence, afterSequence + limit));
    const nextSequence = events.at(-1)?.sequence ?? afterSequence;
    return { events, nextSequence, hasMore: nextSequence < row.events.length };
  }
  /** Host-only observer. Filter authenticated scope before forwarding to a peer. */
  subscribe(listener: (session: ManagedSession, event: ManagedEvent) => void): () => void {
    this.assertOpen(); this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
}
