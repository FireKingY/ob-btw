import type { OpenCodeClient, SessionInfo } from '@opencode/client';
import { LIVE_BTW_RPC } from '@openchamber/sdk';

type Json = null | string | number | boolean | Json[] | { [key: string]: Json };
type RecordValue = { [key: string]: Json };
type Hook = { sessionID: string; system: Json[]; agent: string; model: { id: string; providerID: string } };
type MethodContext = { error: (code: string, message: string, data: RecordValue) => unknown; signal: AbortSignal };
type Method = (input: unknown, context: MethodContext) => Promise<unknown>;
export type CoordinatorContext = {
  location: { directory: string };
  session: Pick<OpenCodeClient['session'], 'get' | 'create' | 'remove' | 'context' | 'update'> & {
    hook(name: 'context', callback: (event: Hook) => Promise<void>): Promise<unknown>;
    hook(name: 'prompt', callback: (event: { sessionID: string; messageID: string }) => Promise<void>): Promise<unknown>;
  };
  rpc: { register: (definition: typeof LIVE_BTW_RPC, handlers: Record<string, Method>) => Promise<unknown> };
  storage: { get: (key: string) => Promise<unknown>; set: (key: string, value: Json) => Promise<void>; remove: (key: string) => Promise<void> };
  event: { subscribe: (input: { types: string[]; signal: AbortSignal }) => AsyncIterable<{ type: string; data: { sessionID?: string } }> };
};
const LEASE_MS = 5 * 60_000;
const object = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const text = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined;
const namespace = (session: SessionInfo) => object(session.metadata?.openchamber);
const live = (session: SessionInfo) => namespace(session).kind === 'btw' && namespace(session).btwMode === 'live';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const json = (value: unknown): Json => clone(value) as Json;
const currentHead = (root: SessionInfo) => text(namespace(root).btwLiveHeadSessionID) ?? root.id;
class Refusal extends Error {
  constructor(readonly code: 'conflict' | 'unavailable', message: string) { super(message); }
}

export function sideMetadata(source: SessionInfo, parentID: string, rootID: string): RecordValue {
  const pins = object(namespace(source).project_context_pins);
  const openchamber: RecordValue = { kind: 'btw', originalSessionID: parentID, btwMode: 'live', btwPresentation: 'side',
    btwLiveRootSessionID: rootID, btwCoordinatorVersion: 2 };
  if (Array.isArray(pins.notes) && Array.isArray(pins.plans)) openchamber.project_context_pins = {
    notes: pins.notes.filter((value) => typeof value === 'string'), plans: pins.plans.filter((value) => typeof value === 'string'),
  };
  return { openchamber };
}

export function createCoordinator(ctx: CoordinatorContext) {
  const locks = new Set<string>();
  let disposed = false;
  const events = new AbortController();
  void (async () => {
    for await (const event of ctx.event.subscribe({ types: ['session.deleted'], signal: events.signal })) {
      const id = event.data.sessionID;
      if (!id) continue;
      await Promise.all([ctx.storage.remove(`prefix/${id}`), ctx.storage.remove(`head-prefix/${id}`), ctx.storage.remove(`lease-prefix/${id}`)]);
    }
  })().catch((error) => { if (!events.signal.aborted) console.warn('BTW prefix cleanup stopped:', error instanceof Error ? error.message : 'event stream ended'); });
  const owned = async (sessionID: string) => {
    const session = await ctx.session.get({ sessionID });
    if (session.location.directory !== ctx.location.directory) throw new Refusal('conflict', 'The live conversation moved. Reopen it before sending.');
    return session;
  };
  const locked = async <T>(id: string, work: () => Promise<T>): Promise<T> => {
    if (locks.has(id)) throw new Refusal('conflict', 'Another client is preparing a live BTW question. Try again after it finishes.');
    locks.add(id);
    try { return await work(); } finally { locks.delete(id); }
  };
  const update = async (id: string, change: RecordValue) => {
    const current = await owned(id);
    await ctx.session.update({ sessionID: id, metadata: { ...current.metadata, openchamber: { ...namespace(current), ...change } } });
  };
  const prefixOf = async (sessionID: string) => {
    const saved = object(await ctx.storage.get(`prefix/${sessionID}`));
    if (!Array.isArray(saved.system) || !text(saved.agent) || !text(object(saved.model).id)) {
      throw new Refusal('unavailable', 'Wait for the main chat to make its next model request after enabling BTW, then send the side question again.');
    }
    return saved;
  };
  const leaseOf = (root: SessionInfo, token: unknown) => {
    const lease = object(namespace(root).btwLiveLease);
    if (lease.token !== token || Number(lease.expiresAt) <= Date.now()) throw new Refusal('conflict', 'This live BTW preparation expired. Send the question again.');
    return lease;
  };
  const reserve = async (input: RecordValue) => {
    const token = crypto.randomUUID();
    let root: SessionInfo;
    let created = false;
    if (text(input.sessionID)) {
      const requested = await owned(String(input.sessionID));
      if (!live(requested)) throw new Refusal('conflict', 'The conversation is not a live BTW conversation.');
      root = await owned(text(namespace(requested).btwLiveRootSessionID) ?? requested.id);
    } else {
      const source = await owned(String(input.parentSessionID ?? ''));
      const parent = live(source) ? await owned(String(namespace(source).originalSessionID)) : source;
      await prefixOf(parent.id);
      const metadata = sideMetadata(parent, parent.id, '');
      object(metadata.openchamber).btwLiveLease = { token, expiresAt: Date.now() + LEASE_MS };
      root = await ctx.session.create({ location: parent.location, title: 'live-btw', agent: parent.agent, model: parent.model, metadata });
      created = true;
    }
    return locked(root.id, async () => {
      let prefixWritten = false;
      try {
        root = await owned(root.id);
        if (namespace(root).btwCoordinatorVersion !== 2) {
          const previous = namespace(root);
          const cleaned = sideMetadata(root, String(previous.originalSessionID), root.id);
          for (const key of ['btwLiveHeadSessionID', 'btwBoundaryMessageID', 'btwSnapshotAt', 'btwLiveRetire', 'btwLiveMessageAliases', 'btwLiveRetired', 'btwLiveLease']) {
            if (previous[key] !== undefined) object(cleaned.openchamber)[key] = previous[key];
          }
          await ctx.session.update({ sessionID: root.id, metadata: cleaned });
          root = await owned(root.id);
        }
        const lease = object(namespace(root).btwLiveLease);
        if (!created && Number(lease.expiresAt) > Date.now()) throw new Refusal('conflict', 'Another live BTW question is being sent. Wait for it to finish.');
        if (!created && text(lease.token)) {
          for (const id of [text(lease.temporarySessionID), text(lease.candidateSessionID)]) {
            if (!id || id === currentHead(root) || id === root.id) continue;
            const abandoned = await owned(id).catch(() => null);
            if (abandoned && live(abandoned) && namespace(abandoned).btwLiveRootSessionID === root.id) await ctx.session.remove({ sessionID: id });
          }
          await ctx.storage.remove(`lease-prefix/${root.id}`);
        }
        const previousSessionID = currentHead(root);
        const parentSessionID = String(namespace(root).originalSessionID);
        const prefix = await prefixOf(parentSessionID);
        prefixWritten = true;
        await ctx.storage.set(`lease-prefix/${root.id}`, prefix);
        await update(root.id, { btwLiveRootSessionID: root.id, btwLiveLease: {
          token, requestID: String(input.requestID), previousSessionID, expiresAt: Date.now() + LEASE_MS, created,
        } });
        return { rootSessionID: root.id, parentSessionID, previousSessionID, token };
      } catch (error) {
        if (created) await ctx.session.remove({ sessionID: root.id }).catch(() => {});
        else if (prefixWritten) {
          const latest = await owned(root.id).catch(() => null);
          if (latest && object(namespace(latest).btwLiveLease).token === token) await update(root.id, { btwLiveLease: null }).catch(() => {});
        }
        if (created || prefixWritten) await ctx.storage.remove(`lease-prefix/${root.id}`).catch(() => {});
        throw error;
      }
    });
  };
  const publish = async (input: RecordValue) => locked(String(input.rootSessionID), async () => {
    const root = await owned(String(input.rootSessionID));
    const lease = leaseOf(root, input.token);
    if (currentHead(root) !== lease.previousSessionID) throw new Refusal('conflict', 'The live conversation advanced. Send the question again.');
    const prepared = await owned(String(input.sessionID));
    if (!live(prepared) || namespace(prepared).btwLiveRootSessionID !== root.id || prepared.parentID !== root.id
      || prepared.id !== lease.candidateSessionID || namespace(prepared).btwLiveRetired === true) {
      throw new Refusal('conflict', 'The prepared snapshot does not belong to this conversation.');
    }
    const prefix = object(await ctx.storage.get(`lease-prefix/${root.id}`));
    const latest = await prefixOf(String(namespace(root).originalSessionID));
    if (!Array.isArray(prefix.system) || JSON.stringify(prefix.system) !== JSON.stringify(latest.system)) {
      throw new Refusal('conflict', 'The main chat changed its instruction baseline during capture. Send the question again.');
    }
    await ctx.storage.set(`head-prefix/${prepared.id}`, prefix);
    const pending = namespace(root).btwLiveRetire;
    await update(root.id, { btwLiveHeadSessionID: prepared.id,
      btwLiveRetire: [...new Set([...(Array.isArray(pending) ? pending : []), String(lease.previousSessionID)])],
      btwLiveLease: { ...lease, preparedSessionID: prepared.id },
    });
    return { ok: true };
  });
  const track = async (input: RecordValue) => locked(String(input.rootSessionID), async () => {
    const root = await owned(String(input.rootSessionID));
    const lease = leaseOf(root, input.token);
    const temporary = await owned(String(input.temporarySessionID));
    if (!live(temporary) || namespace(temporary).btwLiveRootSessionID !== root.id) throw new Refusal('conflict', 'The temporary snapshot has another owner.');
    await update(root.id, { btwLiveLease: { ...lease, temporarySessionID: temporary.id, candidateSessionID: String(input.candidateSessionID) } });
    return { ok: true };
  });
  const finish = async (input: RecordValue) => locked(String(input.rootSessionID), async () => {
    const root = await owned(String(input.rootSessionID));
    const lease = leaseOf(root, input.token);
    const head = currentHead(root);
    for (const id of [text(lease.temporarySessionID), text(lease.candidateSessionID)]) {
      if (!id || id === head || id === root.id) continue;
      const orphan = await owned(id).catch(() => null);
      if (orphan && live(orphan) && namespace(orphan).btwLiveRootSessionID === root.id) {
        await ctx.session.remove({ sessionID: id });
        await ctx.storage.remove(`head-prefix/${id}`);
      }
    }
    if (input.accepted !== true && !lease.preparedSessionID && lease.created === true) {
      await ctx.session.remove({ sessionID: root.id });
      await ctx.storage.remove(`lease-prefix/${root.id}`);
      return { ok: true, retire: [] };
    }
    const pending = namespace(root).btwLiveRetire;
    const retire = input.accepted === true && text(lease.messageID) && Array.isArray(pending)
      ? pending.filter((id): id is string => typeof id === 'string' && id !== head) : [];
    for (const id of retire) {
      const old = await owned(id);
      if (!live(old) || (text(namespace(old).btwLiveRootSessionID) ?? old.id) !== root.id) continue;
      const oldNamespace = namespace(old);
      const alreadyRetired = oldNamespace.btwLiveRetired === true;
      const aliases = alreadyRetired ? object(oldNamespace.btwLiveMessageAliases) : {};
      const messages = alreadyRetired ? [] : await ctx.session.context({ sessionID: id });
      const boundary = text(oldNamespace.btwBoundaryMessageID);
      const boundaryIndex = boundary ? messages.findIndex((message) => message.id === boundary) : -1;
      for (const message of messages.slice(boundaryIndex + 1)) {
        if (oldNamespace.btwCoordinatorVersion === 2 && message.metadata?.openchamberLiveBtwOrder !== undefined) continue;
        if (message.type === 'user' || message.type === 'assistant') {
          aliases[message.id] ??= json(message.metadata?.openchamberLiveBtwOrigin ?? { sessionID: id, messageID: message.id });
        }
      }
      await update(id, { btwLiveRetired: true, btwLiveMessageAliases: aliases, btwLiveOrigins: null });
    }
    await update(root.id, { btwLiveLease: null });
    await ctx.storage.remove(`lease-prefix/${root.id}`);
    return { ok: true, retire };
  });
  const retired = async (input: RecordValue) => locked(String(input.rootSessionID), async () => {
    const root = await owned(String(input.rootSessionID));
    const id = String(input.sessionID);
    const old = await owned(id);
    if (id === currentHead(root) || namespace(old).btwLiveRetired !== true
      || (text(namespace(old).btwLiveRootSessionID) ?? old.id) !== root.id) throw new Refusal('conflict', 'This transcript is still in use.');
    if ((await ctx.session.context({ sessionID: id })).length > 0) throw new Refusal('conflict', 'Snapshot cleanup did not finish.');
    const pending = namespace(root).btwLiveRetire;
    await update(root.id, { btwLiveRetire: Array.isArray(pending) ? pending.filter((value) => value !== id) : [] });
    await ctx.storage.remove(`head-prefix/${id}`);
    return { ok: true };
  });
  const resolve = async (input: RecordValue) => {
    const requested = await owned(String(input.sessionID));
    if (!live(requested)) throw new Refusal('conflict', 'The conversation is not a live BTW conversation.');
    const root = await owned(text(namespace(requested).btwLiveRootSessionID) ?? requested.id);
    const head = await owned(currentHead(root));
    let messageID = text(input.messageID);
    if (messageID && head.id !== requested.id) {
      const alias = object(object(namespace(requested).btwLiveMessageAliases)[messageID]);
      const key = JSON.stringify([text(alias.sessionID) ?? requested.id, text(alias.messageID) ?? messageID]);
      messageID = text(object(namespace(head).btwLiveOrigins)[key]);
    }
    return { sessionID: head.id, rootSessionID: root.id, ...(messageID ? { messageID } : {}) };
  };
  const snapshot = async (input: RecordValue) => {
    const session = await owned(String(input.sessionID));
    if (namespace(session).kind !== 'btw' || namespace(session).originalSessionID !== input.parentSessionID) throw new Refusal('conflict', 'The snapshot has another source session.');
    const prefix = object(await ctx.storage.get(`prefix/${String(input.parentSessionID)}`));
    if (!Array.isArray(prefix.system)) return { bound: false };
    await ctx.storage.set(`head-prefix/${session.id}`, prefix);
    return { bound: true };
  };
  const method = (run: (input: RecordValue) => Promise<unknown>): Method => async (input, context) => {
    try {
      context.signal.throwIfAborted();
      if (disposed) throw new Refusal('unavailable', 'The BTW coordinator is reloading. Send the question again.');
      return await run(object(input));
    } catch (error) {
      return context.error(error instanceof Refusal ? error.code : 'unavailable', error instanceof Error ? error.message : 'The live context operation failed.', {});
    }
  };
  return {
    methods: { reserve: method(reserve), publish: method(publish), track: method(track), finish: method(finish), retired: method(retired), resolve: method(resolve), snapshot: method(snapshot), status: method(async () => ({ version: 2, prefixCapture: true })) },
    prompt: async (event: { sessionID: string; messageID: string }) => {
      const session = await owned(event.sessionID);
      if (!live(session)) return;
      const rootID = text(namespace(session).btwLiveRootSessionID) ?? session.id;
      await locked(rootID, async () => {
        const root = await owned(rootID);
        const lease = object(namespace(root).btwLiveLease);
        if (namespace(session).btwLiveRetired === true || currentHead(root) !== session.id
          || lease.preparedSessionID !== session.id || Number(lease.expiresAt) <= Date.now()) {
          throw new Error('This live BTW snapshot no longer owns the send. Reopen the live conversation and send the question again.');
        }
        // A prepared head admits one question. Native retries use the same message ID.
        if (lease.messageID && lease.messageID !== event.messageID) throw new Error('A question was already admitted to this live BTW snapshot.');
        await update(rootID, { btwLiveLease: { ...lease, messageID: event.messageID } });
      });
    },
    context: async (event: Hook) => {
      const session = await owned(event.sessionID);
      if (namespace(session).kind === 'btw') {
        const saved = object(await ctx.storage.get(`head-prefix/${session.id}`));
        if (Array.isArray(saved.system) && saved.agent === event.agent && object(saved.model).id === event.model.id && object(saved.model).providerID === event.model.providerID) event.system = clone(saved.system);
        if (live(session)) return;
      }
      const key = `prefix/${session.id}`;
      const current = object(await ctx.storage.get(key));
      if (JSON.stringify(current.system) !== JSON.stringify(event.system) || current.agent !== event.agent || JSON.stringify(current.model) !== JSON.stringify(event.model)) {
        await ctx.storage.set(key, json({ system: event.system, agent: event.agent, model: event.model }));
      }
    },
    dispose: () => { disposed = true; events.abort(); },
  };
}
