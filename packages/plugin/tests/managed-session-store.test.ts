import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManagedSessionStore } from '../src/managed-session-store/index.js';
const scope = { ownerId: 'account-a', hostId: 'host-a', workspaceId: 'workspace-a' };
const input = { operationId: 'create-a', agentId: 'codex', providerId: 'codex', workspacePath: '/project-a' };
const directories: string[] = [];
const stores: ManagedSessionStore[] = [];
function open(directory?: string) {
  const dir = directory ?? mkdtempSync(join(tmpdir(), 'managed-store-'));
  if (!directories.includes(dir)) directories.push(dir);
  const store = ManagedSessionStore.open(dir); stores.push(store); return { dir, store };
}
afterEach(() => { stores.splice(0).forEach(s => s.close()); directories.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
describe('managed session durability and isolation', () => {
  it('keeps stable create identity across restarts and rejects changed request reuse', () => {
    const { dir, store } = open(); const session = store.createSession(scope, input);
    expect(store.createSession(scope, input).id).toBe(session.id);
    expect(() => store.createSession(scope, { ...input, agentId: 'claude' })).toThrow('CONFLICT');
    store.bindProviderSession(scope, session.id, 'provider-thread'); store.close();
    const recovered = open(dir).store;
    expect(recovered.createSession(scope, input)).toMatchObject({ id: session.id, providerSessionId: 'provider-thread' });
    expect(() => recovered.bindProviderSession(scope, session.id, 'another')).toThrow('CONFLICT');
  });
  it('does not expose any session or events to another account, host or workspace', () => {
    const { store } = open(); const session = store.createSession(scope, input);
    for (const other of [{ ...scope, ownerId: 'b' }, { ...scope, hostId: 'b' }, { ...scope, workspaceId: 'b' }]) {
      expect(store.listSessions(other)).toEqual([]);
      expect(() => store.readEvents(other, session.id)).toThrow('NOT_FOUND');
      expect(() => store.beginOperation(other, session.id, { operationId: 'x', kind: 'send', input: 'secret' })).toThrow('NOT_FOUND');
    }
  });
  it('persists pending before execution and never automatically reexecutes unknown outcomes', () => {
    const { store, dir } = open(); const session = store.createSession(scope, input);
    const operation = { operationId: 'send-1', kind: 'send', input: { text: 'hello' } };
    expect(store.beginOperation(scope, session.id, operation).execute).toBe(true);
    expect(store.beginOperation(scope, session.id, operation).execute).toBe(false);
    store.close(); const recovered = open(dir).store;
    expect(recovered.beginOperation(scope, session.id, operation)).toMatchObject({ execute: false, receipt: { status: 'unknown' } });
    expect(() => recovered.beginOperation(scope, session.id, { ...operation, input: 'different' })).toThrow('CONFLICT');
    recovered.completeOperation(scope, session.id, operation.operationId, 'completed', { turnId: 'turn-1' });
    recovered.close(); const again = open(dir).store;
    expect(again.beginOperation(scope, session.id, operation)).toMatchObject({ execute: false, receipt: { result: { turnId: 'turn-1' }, status: 'completed' } });
  });
  it('replays ordered deduplicated events after cursor with post-commit subscriptions', () => {
    const { store, dir } = open(); const session = store.createSession(scope, input);
    let count = 0;
    store.subscribe((_session, event) => { count++; expect(store.readEvents(scope, session.id).events.at(-1)).toEqual(event); });
    for (let i = 0; i < 3; i++) store.appendEvent(scope, session.id, { eventId: `event-${i}`, type: 'message', payload: { text: `message-${i}` } });
    expect(store.appendEvent(scope, session.id, { eventId: 'event-0', type: 'message', payload: { text: 'message-0' } }).sequence).toBe(1);
    expect(count).toBe(3);
    expect(() => store.appendEvent(scope, session.id, { eventId: 'event-0', type: 'message', payload: 'changed' })).toThrow('CONFLICT');
    store.close(); const recovered = open(dir).store;
    expect(recovered.readEvents(scope, session.id, 1, 1)).toMatchObject({ events: [{ sequence: 2 }], nextSequence: 2, hasMore: true });
    expect(recovered.readEvents(scope, session.id, 3)).toEqual({ events: [], nextSequence: 3, hasMore: false });
    expect(() => recovered.readEvents(scope, session.id, 4)).toThrow('CURSOR_INVALID');
  });
  it('excludes simultaneous writers and automatically recovers dead unique holders', () => {
    const { store, dir } = open();
    expect(() => ManagedSessionStore.open(dir)).toThrow('WRITER_BUSY');
    store.createSession(scope, input); store.close();
    // Linux PID maximum is below this value; do not depend on another live process.
    writeFileSync(join(dir, 'writer-2147483647-00000000-0000-4000-8000-000000000000.lock'), '{}');
    expect(open(dir).store.listSessions(scope)).toHaveLength(1);
  });
  it('returns defensive copies and rejects oversized values', () => {
    const { store } = open(); const session = store.createSession(scope, input);
    session.workspaceId = 'mutated';
    expect(store.listSessions(scope)[0]?.workspaceId).toBe(scope.workspaceId);
    expect(() => store.appendEvent(scope, session.id, { eventId: 'huge', type: 'message', payload: 'x'.repeat(1024 * 1024) })).toThrow('TOO_LARGE');
  });
  it('recovers actual crashed process pending operations without creating a second session', async () => {
    const { dir, store } = open(); store.close();
    const source = new URL('../src/managed-session-store/index.ts', import.meta.url).href;
    const child = spawn(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', `
      import { ManagedSessionStore } from ${JSON.stringify(source)};
      const store = ManagedSessionStore.open(${JSON.stringify(dir)});
      const scope = ${JSON.stringify(scope)};
      const session = store.createSession(scope, ${JSON.stringify(input)});
      store.beginOperation(scope, session.id, { operationId: 'crash-send', kind: 'send', input: 'hello' });
      process.send({ sessionId: session.id });
      setInterval(() => {}, 1000);
    `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    try {
      const [message] = await once(child, 'message') as [{ sessionId: string }];
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
      const recovered = open(dir).store;
      expect(recovered.createSession(scope, input).id).toBe(message.sessionId);
      expect(recovered.beginOperation(scope, message.sessionId, { operationId: 'crash-send', kind: 'send', input: 'hello' })).toMatchObject({ execute: false, receipt: { status: 'unknown' } });
    } finally { child.kill('SIGKILL'); }
  }, 10000);
  it('never grants the store to two concurrent independent processes', async () => {
    const { dir, store } = open(); store.close();
    const source = new URL('../src/managed-session-store/index.ts', import.meta.url).href;
    const children: ChildProcess[] = [];
    try {
      const attempts = Array.from({ length: 3 }, () => {
        const child = spawn(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', `
          import { ManagedSessionStore } from ${JSON.stringify(source)};
          process.on('message', () => {
            try { globalThis.store = ManagedSessionStore.open(${JSON.stringify(dir)}); process.send({ acquired: true }); }
            catch { process.send({ acquired: false }); }
          });
          process.send({ ready: true });
        `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        children.push(child);
        return once(child, 'message');
      });
      await Promise.all(attempts);
      const results = children.map(child => once(child, 'message'));
      children.forEach(child => child.send('start'));
      const outcomes = await Promise.all(results) as [{ acquired: boolean }][];
      expect(outcomes.filter(([result]) => result.acquired).length).toBeLessThanOrEqual(1);
    } finally {
      await Promise.all(children.map(async child => { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }));
    }
    // All lock holders are now dead; a fresh writer can recover automatically.
    expect(open(dir).store.listSessions(scope)).toEqual([]);
  }, 10000);

});
