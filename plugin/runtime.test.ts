import { expect, spyOn, test } from 'bun:test';
import type { SessionInfo } from '@opencode/client';
import { z } from 'zod';
import { createCoordinator, type CoordinatorContext } from './runtime';

const fixture = () => {
  const sessions = new Map<string, SessionInfo>();
  const storage = new Map<string, unknown>();
  let serial = 0;
  const ctx: CoordinatorContext = {
    location: { directory: '/fixture' },
    session: {
      get: async ({ sessionID }) => {
        const session = sessions.get(sessionID);
        if (!session) throw new Error('session missing');
        return structuredClone(session);
      },
      create: async (input) => {
        const session: SessionInfo = { id: `session-${++serial}`, projectID: 'fixture',
          title: input?.title ?? 'fixture', location: { directory: '/fixture' },
          parentID: input?.parentID ?? undefined, metadata: input?.metadata ?? undefined,
          cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now(), updated: Date.now() } };
        sessions.set(session.id, structuredClone(session));
        return session;
      },
      update: async ({ sessionID, metadata }) => {
        const current = sessions.get(sessionID);
        if (!current) throw new Error('session missing');
        sessions.set(sessionID, { ...current, metadata });
      },
      remove: async ({ sessionID }) => { sessions.delete(sessionID); },
      context: async () => [],
      interrupt: async () => ({ interrupted: true }),
      hook: async () => undefined,
    },
    storage: {
      get: async (key) => structuredClone(storage.get(key)),
      set: async (key, value) => { storage.set(key, structuredClone(value)); },
      remove: async (key) => { storage.delete(key); },
    },
    rpc: { register: async () => undefined },
    event: { subscribe: async function* () {} },
  };
  return { ctx, sessions };
};
const context = { signal: new AbortController().signal,
  error: (code: string, message: string) => { throw new Error(`${code}: ${message}`); } };
const leaseSchema = z.object({ rootSessionID: z.string(), token: z.string(), previousSessionID: z.string() });

test('expired admission is refused after the coordinator reloads', async () => {
  const { ctx } = fixture();
  const clock = spyOn(Date, 'now').mockReturnValue(1_000_000);
  let coordinator = createCoordinator(ctx);
  try {
    const main = await ctx.session.create({ title: 'main' });
    const lease = leaseSchema.parse(await coordinator.methods.reserve({ parentSessionID: main.id, requestID: 'first' }, context));
    const metadata = { openchamber: { kind: 'btw', originalSessionID: main.id, btwMode: 'live', btwLiveRootSessionID: lease.rootSessionID } };
    const head = await ctx.session.create({ parentID: lease.rootSessionID, metadata });
    await coordinator.methods.track({ ...lease, temporarySessionID: head.id, candidateSessionID: head.id }, context);
    await coordinator.methods.publish({ ...lease, sessionID: head.id }, context);
    coordinator.dispose();
    coordinator = createCoordinator(ctx);
    clock.mockReturnValue(1_300_001);
    await expect(coordinator.prompt({ sessionID: head.id, messageID: 'expired' })).rejects.toThrow('no longer owns the send');
  } finally { coordinator.dispose(); clock.mockRestore(); }
});

test('a stale host metadata write cannot restore a completed lease after reload', async () => {
  const { ctx, sessions } = fixture();
  let coordinator = createCoordinator(ctx);
  try {
    const main = await ctx.session.create({ title: 'main' });
    const lease = leaseSchema.parse(await coordinator.methods.reserve({ parentSessionID: main.id, requestID: 'first' }, context));
    const head = await ctx.session.create({ parentID: lease.rootSessionID, metadata: { openchamber: {
      kind: 'btw', originalSessionID: main.id, btwMode: 'live', btwLiveRootSessionID: lease.rootSessionID,
    } } });
    await coordinator.methods.track({ ...lease, temporarySessionID: head.id, candidateSessionID: head.id }, context);
    await coordinator.methods.publish({ ...lease, sessionID: head.id }, context);
    await coordinator.prompt({ sessionID: head.id, messageID: 'accepted' });
    const stale = await ctx.session.get({ sessionID: lease.rootSessionID });
    const staleNamespace = z.record(z.string(), z.json()).parse(stale.metadata?.openchamber);
    stale.metadata = { ...stale.metadata, openchamber: { ...staleNamespace, independentHostField: 'keep' } };
    await coordinator.methods.finish({ ...lease, accepted: true }, context);
    sessions.set(stale.id, stale);
    coordinator.dispose();
    coordinator = createCoordinator(ctx);
    const next = leaseSchema.parse(await coordinator.methods.reserve({ sessionID: head.id, requestID: 'second' }, context));
    expect(next.rootSessionID).toBe(lease.rootSessionID);
    expect(next.previousSessionID).toBe(head.id);
    expect(next.token).not.toBe(lease.token);
    const projected = z.object({ independentHostField: z.string() }).parse((await ctx.session.get({ sessionID: lease.rootSessionID })).metadata?.openchamber);
    expect(projected.independentHostField).toBe('keep');
  } finally { coordinator.dispose(); }
});

test('a legacy live root migrates without leaving markers shared with its execution head', async () => {
  const { ctx, sessions } = fixture();
  let coordinator = createCoordinator(ctx);
  try {
    const main = await ctx.session.create({ title: 'main' });
    const root = await ctx.session.create({ metadata: { openchamber: {
      kind: 'btw', originalSessionID: main.id, btwMode: 'live', btwCoordinatorVersion: 2,
      project_context_pins: { notes: ['kept'], plans: [] }, independentHostField: 'keep',
    } } });
    const metadata = z.record(z.string(), z.json()).parse(root.metadata?.openchamber);
    await ctx.session.update({ sessionID: root.id, metadata: { openchamber: { ...metadata, btwLiveRootSessionID: root.id } } });
    const legacy = await ctx.session.get({ sessionID: root.id });
    await coordinator.methods.reserve({ sessionID: root.id, requestID: 'migrated' }, context);
    const migrated = z.record(z.string(), z.json()).parse((await ctx.session.get({ sessionID: root.id })).metadata?.openchamber);
    expect(migrated.kind).toBeUndefined();
    expect(migrated.independentHostField).toBe('keep');
    expect(z.object({ project_context_pins: z.object({ notes: z.array(z.string()) }) }).parse(migrated.btwLiveContainer).project_context_pins.notes).toEqual(['kept']);
    sessions.set(root.id, legacy);
    coordinator.dispose();
    coordinator = createCoordinator(ctx);
    await expect(coordinator.methods.reserve({ sessionID: root.id, requestID: 'duplicate' }, context)).rejects.toThrow('Another live BTW question');
    const resolved = await coordinator.methods.resolve({ sessionID: root.id }, context);
    expect(resolved).toEqual({ sessionID: root.id, rootSessionID: root.id });
  } finally { coordinator.dispose(); }
});
