import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const host = resolve(process.env.BTW_HOST_DIR ?? '../openchamber');
const plugin = resolve('plugin');
const output = resolve(process.env.BTW_OUTPUT_DIR ?? join(tmpdir(), 'ob-btw-verification'));
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(output, 'coordinator-'));
const project = join(root, 'project');
await mkdir(project);
await writeFile(join(project, 'opencode.json'), JSON.stringify({ plugins: [plugin] }));
const { OpenCode } = await import(pathToFileURL(join(host, 'node_modules/@opencode/client/dist/promise/index.js')).href);
const { startIsolatedServer } = await import(pathToFileURL(join(host, 'scripts/perf/isolated-server.mjs')).href);
const { LIVE_BTW_RPC } = await import(pathToFileURL(join(host, 'packages/sdk/dist/btw-rpc.js')).href);
const { buildLiveBtwTranscript, finishLiveBtwTranscript } = await import(pathToFileURL(join(host, 'packages/ui/src/lib/opencode/live-btw-transport.ts')).href);
const requests: Array<{ messages: Array<{ role: string; content: unknown }>; [key: string]: unknown }> = [];
const provider = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push(body);
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [content, finish] of [['Formal response for the synthetic question.', null], ['', 'stop']]) {
    response.write(`data: ${JSON.stringify({ id: 'coordinator-fixture', object: 'chat.completion.chunk', created: 1, model: body.model,
      choices: [{ index: 0, delta: content ? { role: 'assistant', content } : {}, finish_reason: finish }] })}\n\n`);
  }
  response.end('data: [DONE]\n\n');
});
await new Promise<void>((resolve) => provider.listen(4848, '127.0.0.1', resolve));
let server;
let stage = 'startup';
try {
  server = await startIsolatedServer({ repo: host, dist: join(host, 'packages/web/dist'), state: join(root, 'state'), project, port: 4849, fixturePort: 4848, logFile: join(root, 'server.log') });
  const sdk = OpenCode.make({ baseUrl: 'http://localhost:4849', headers: { 'x-opencode-directory': encodeURIComponent(project) } });
  await sdk.model.list();
  const rpc = sdk.rpc(LIVE_BTW_RPC);
  const options = { location: { directory: project } };
  const prepare = async (input) => {
    const lease = await rpc.reserve(input, options);
    try {
      const result = await buildLiveBtwTranscript({ sdk: () => sdk, directory: project, lease, check: () => {},
        cleanup: (sessionID) => sdk.session.remove({ sessionID }), materialize: async () => {},
      });
      return { ...lease, sessionID: result.session.id };
    } catch (error) { await finishLiveBtwTranscript(sdk, lease, project, false); throw error; }
  };
  const finish = (turn) => finishLiveBtwTranscript(sdk, turn, project, true);
  stage = 'status';
  const status = await rpc.status({}, options);
  assert.equal(status.version, 2);
  const parent = await sdk.session.create({ location: { directory: project }, title: 'Coordinator main fixture', agent: 'build', model: { providerID: 'perf', id: 'stream-300cps' } });
  await sdk.experimental.session.instructions.entry.put({ sessionID: parent.id, key: 'prefix-proof', value: 'ORIGINAL_BASELINE' });
  await sdk.session.prompt({ sessionID: parent.id, text: 'MAIN_ONE' });
  await sdk.experimental.session.wait({ sessionID: parent.id });
  await sdk.experimental.session.instructions.entry.put({ sessionID: parent.id, key: 'prefix-proof', value: 'UPDATED_INSTRUCTION' });
  await sdk.session.prompt({ sessionID: parent.id, text: 'MAIN_TWO' });
  await sdk.experimental.session.wait({ sessionID: parent.id });
  const pins = { notes: ['synthetic-note'], plans: [] };
  const metadataWrite = await fetch(`http://localhost:4849/api/openchamber/sessions/${parent.id}/metadata`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-opencode-directory': encodeURIComponent(project) },
    body: JSON.stringify({ patch: { openchamber: {
      goal: { id: 'main-goal', objective: 'Do the main task', status: 'active', turnsUsed: 5 },
      reviewSessionID: 'source-owned-review', project_context_pins: pins,
    } } }),
  });
  assert.equal(metadataWrite.status, 200);
  const mainWire = requests.at(-1)!;
  stage = 'first prepare';
  const first = await prepare({ parentSessionID: parent.id, requestID: crypto.randomUUID() });
  const firstInfo = await sdk.session.get({ sessionID: first.sessionID });
  const rootInfo = await sdk.session.get({ sessionID: first.rootSessionID });
  for (const session of [firstInfo, rootInfo]) {
    assert.equal(session.metadata.openchamber.goal, undefined);
    assert.equal(session.metadata.openchamber.reviewSessionID, undefined);
    assert.deepEqual(session.metadata.openchamber.project_context_pins, pins);
  }
  await sdk.session.prompt({ sessionID: first.sessionID, text: 'SIDE_ONE' });
  await sdk.experimental.session.wait({ sessionID: first.sessionID });
  stage = 'first finish';
  await finish(first);
  const sideWire = requests.at(-1)!;
  assert.deepEqual(sideWire.messages.slice(0, mainWire.messages.length), mainWire.messages);
  const { messages: mainMessages, ...mainOptions } = mainWire;
  const { messages: sideMessages, ...sideOptions } = sideWire;
  assert.deepEqual(sideOptions, mainOptions);
  const firstRecords = await sdk.session.context({ sessionID: first.sessionID });
  const firstQuestion = firstRecords.find((message) => message.type === 'user' && message.text === 'SIDE_ONE')!;
  stage = 'concurrent prepare';
  const concurrent = await Promise.allSettled([
    prepare({ sessionID: first.sessionID, requestID: crypto.randomUUID() }),
    prepare({ sessionID: first.sessionID, requestID: crypto.randomUUID() }),
  ]);
  assert.equal(concurrent.filter((entry) => entry.status === 'fulfilled').length, 1);
  const second = concurrent.find((entry) => entry.status === 'fulfilled')!.value;
  await assert.rejects(prepare({ sessionID: first.sessionID, requestID: crypto.randomUUID() }));
  await sdk.session.prompt({ sessionID: second.sessionID, text: 'SIDE_TWO' });
  await sdk.experimental.session.wait({ sessionID: second.sessionID });
  await finish(second);
  assert.equal((await sdk.session.context({ sessionID: first.sessionID })).length, 0);
  const secondRecords = await sdk.session.context({ sessionID: second.sessionID });
  assert(secondRecords.some((message) => message.type === 'user' && message.text === 'SIDE_ONE'));
  assert(secondRecords.some((message) => message.type === 'user' && message.text === 'SIDE_TWO'));
  const link = await rpc.resolve({ sessionID: first.sessionID, messageID: firstQuestion.id }, options);
  assert.equal(link.sessionID, second.sessionID);
  assert.equal(secondRecords.find((message) => message.id === link.messageID)?.text, 'SIDE_ONE');
  const third = await prepare({ sessionID: first.rootSessionID, requestID: crypto.randomUUID() });
  await sdk.session.prompt({ sessionID: third.sessionID, text: 'SIDE_THREE' });
  await sdk.experimental.session.wait({ sessionID: third.sessionID });
  await finish(third);
  assert.equal((await sdk.session.context({ sessionID: second.sessionID })).length, 0);
  assert.equal(Object.keys((await sdk.session.get({ sessionID: first.sessionID })).metadata.openchamber.btwLiveMessageAliases).length, 2);
  assert.equal(Object.keys((await sdk.session.get({ sessionID: second.sessionID })).metadata.openchamber.btwLiveMessageAliases).length, 2);
  const thirdRecords = await sdk.session.context({ sessionID: third.sessionID });
  const premiseText = thirdRecords.filter((message) => message.type === 'synthetic').map((message) => message.text).join('\n');
  assert(premiseText.includes('same main-session premise as side question 1'));
  const resolvedOld = await rpc.resolve({ sessionID: first.sessionID, messageID: firstQuestion.id }, options);
  assert.equal(resolvedOld.sessionID, third.sessionID);
  assert.equal(thirdRecords.find((message) => message.id === resolvedOld.messageID)?.text, 'SIDE_ONE');
  stage = 'expired prompt admission';
  const expired = await prepare({ sessionID: third.rootSessionID, requestID: crypto.randomUUID() });
  const expiryRoot = await sdk.session.get({ sessionID: expired.rootSessionID });
  await sdk.session.update({ sessionID: expiryRoot.id, metadata: { ...expiryRoot.metadata, openchamber: {
    ...expiryRoot.metadata.openchamber, btwLiveLease: { ...expiryRoot.metadata.openchamber.btwLiveLease, expiresAt: 1 },
  } } });
  const requestCount = requests.length;
  await assert.rejects(sdk.session.prompt({ sessionID: expired.sessionID, text: 'STALE_QUESTION_MUST_NOT_RUN' }));
  assert.equal(requests.length, requestCount);
  const next = await prepare({ sessionID: third.rootSessionID, requestID: crypto.randomUUID() });
  await sdk.session.prompt({ sessionID: next.sessionID, text: 'SIDE_FOUR' });
  await sdk.experimental.session.wait({ sessionID: next.sessionID });
  await finish(next);
  await assert.rejects(sdk.session.prompt({ sessionID: expired.sessionID, text: 'RETIRED_QUESTION_MUST_NOT_RUN' }));

  stage = 'runtime switch during fork cleanup';
  const lease = await rpc.reserve({ sessionID: next.rootSessionID, requestID: crypto.randomUUID() }, options);
  let current = true;
  const cleaned: string[] = [];
  const switching = { ...sdk, session: { ...sdk.session, fork: async (input) => {
    const response = await sdk.session.fork(input); current = false; return response;
  } } };
  await assert.rejects(buildLiveBtwTranscript({ sdk: () => switching, directory: project, lease,
    check: () => { if (!current) throw new Error('runtime changed'); },
    cleanup: async (sessionID) => { cleaned.push(sessionID); await sdk.session.remove({ sessionID }); }, materialize: async () => {},
  }));
  await finishLiveBtwTranscript(sdk, lease, project, false);
  assert.equal(cleaned.length, 1);
  await assert.rejects(sdk.session.get({ sessionID: cleaned[0] }));

  stage = 'failed import materialization cleanup';
  const failingLease = await rpc.reserve({ sessionID: next.rootSessionID, requestID: crypto.randomUUID() }, options);
  let candidate;
  await assert.rejects(buildLiveBtwTranscript({ sdk: () => sdk, directory: project, lease: failingLease,
    check: () => {}, cleanup: (sessionID) => sdk.session.remove({ sessionID }),
    materialize: async (session) => { candidate = session.id; throw new Error('Synthetic materialization failure'); },
  }));
  await finishLiveBtwTranscript(sdk, failingLease, project, false);
  await assert.rejects(sdk.session.get({ sessionID: candidate }));
  assert.equal((await sdk.session.get({ sessionID: next.rootSessionID })).metadata.openchamber.btwLiveHeadSessionID, next.sessionID);

  stage = 'ordinary BTW prefix binding';
  const ordinary = await sdk.session.fork({ sessionID: parent.id });
  await sdk.session.update({ sessionID: ordinary.id, metadata: { openchamber: { kind: 'btw', originalSessionID: parent.id } } });
  await rpc.snapshot({ sessionID: ordinary.id, parentSessionID: parent.id }, options);
  await sdk.session.synthetic({ sessionID: ordinary.id, text: 'Read-only side conversation. Main history is reference.', resume: false });
  await sdk.session.prompt({ sessionID: ordinary.id, text: 'ORDINARY_SIDE_QUESTION' });
  await sdk.experimental.session.wait({ sessionID: ordinary.id });
  assert.deepEqual(requests.at(-1)!.messages.slice(0, mainWire.messages.length), mainWire.messages);
  const result = { serverCoordination: 'passed', concurrentWriters: 'one accepted, one refused', activeLeaseBlocksAnotherClient: true,
    originalSystemBaselineAfterInstructionUpdate: true, unchangedMainMessagesPrefix: true, unchangedToolsAndOptions: true,
    automationMetadataExcluded: true, productionPinsPreserved: true, retiredSnapshotsEmpty: true, oldMessageLinksResolve: true,
    repeatedPremiseDeduplicated: true, nativeHistoryRetained: true,
    retiredAliasCountPerTurn: 2, expiredAndRetiredPromptsRejected: true,
    runtimeSwitchForkCleanup: true, failedMaterializationCleanup: true, ordinaryBtwPrefixPreserved: true,
    scope: 'Real OpenCode plugin RPC and model serialization, synthetic deterministic provider. No live-provider cache ratio measured.' };
  await writeFile(join(output, 'coordinator-proof.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(stage, error);
  console.error(`Isolated logs: ${root}`);
  process.exitCode = 1;
} finally {
  if (server) await server.stop();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
}
