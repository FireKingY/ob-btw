import { createServer, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = resolve(process.env.BTW_HOST_DIR ?? '../openchamber');
const { chromium, expect } = await import(process.env.BTW_PLAYWRIGHT_MODULE ?? '@playwright/test');
const { OpenCode } = await import(pathToFileURL(join(repo, 'node_modules/@opencode/client/dist/promise/index.js')).href);
const { LIVE_BTW_RPC } = await import(pathToFileURL(join(repo, 'packages/sdk/dist/btw-rpc.js')).href);
const { startIsolatedServer } = await import(pathToFileURL(join(repo, 'scripts/perf/isolated-server.mjs')).href);
const output = resolve(process.env.BTW_OUTPUT_DIR ?? join(tmpdir(), 'ob-btw-verification'));
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(output, 'live-btw-'));
const project = join(root, 'project');
await mkdir(project);
const coldSource = process.argv.includes('--cold-source');
await writeFile(join(project, 'opencode.json'), JSON.stringify({ plugins: coldSource ? [] : [resolve('plugin')] }));
const before = process.argv.includes('--before');
const dist = process.env.BTW_PROOF_DIST ?? join(repo, 'packages/web/dist');
const requests: Array<Record<string, unknown> & { messages: unknown[] }> = [];
let mainCalls = 0;
let sideFirstCalls = 0;
let advanceMain: (() => void) | undefined;
let finishMain: (() => void) | undefined;
const advanceGate = new Promise<void>((resolve) => { advanceMain = resolve; });
const finishGate = new Promise<void>((resolve) => { finishMain = resolve; });

const chunk = (response: ServerResponse, content: string, finish?: 'stop' | 'tool_calls') => {
  response.write(`data: ${JSON.stringify({ id: 'live-btw-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture',
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finish ?? null }] })}\n\n`);
  if (finish) response.end('data: [DONE]\n\n');
};
const tool = (response: ServerResponse, text: string, id: string) => {
  chunk(response, `${text}\n\n`);
  response.write(`data: ${JSON.stringify({ id: 'live-btw-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture',
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'glob', arguments: '{"pattern":"*.md"}' } }] }, finish_reason: null }] })}\n\n`);
  chunk(response, '', 'tool_calls');
};
const provider = createServer(async (request, response) => {
  const buffers: Buffer[] = [];
  for await (const part of request) buffers.push(Buffer.from(part));
  const body = JSON.parse(Buffer.concat(buffers).toString());
  requests.push(body);
  const text = JSON.stringify(body.messages);
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  response.flushHeaders();
  response.write(`data: ${JSON.stringify({ id: 'live-btw-fixture', object: 'chat.completion.chunk', created: 1, model: body.model,
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`);
  if (text.includes('LIVE_SIDE_THIRD')) {
    chunk(response, 'THIRD_FORMAL_ANSWER: The live conversation remains connected.');
    chunk(response, '', 'stop');
  } else if (text.includes('LIVE_SIDE_SECOND')) {
    chunk(response, 'SECOND_FORMAL_ANSWER: The main session has new progress.');
    chunk(response, '', 'stop');
  } else if (text.includes('LIVE_SIDE_FIRST')) {
    sideFirstCalls += 1;
    if (sideFirstCalls === 1) tool(response, 'FIRST_SIDE_WORK_SHOULD_DROP', 'side-inspection');
    else {
      chunk(response, 'FIRST_FORMAL_ANSWER: The main task is still running.');
      chunk(response, '', 'stop');
    }
  } else if (text.includes('LIVE_MAIN_TASK')) {
    mainCalls += 1;
    if (mainCalls === 1) tool(response, 'MAIN_PREMISE_ONE', 'main-first');
    else if (mainCalls === 2) {
      await advanceGate;
      if (!response.writableEnded) tool(response, 'MAIN_PREMISE_TWO', 'main-second');
    } else {
      await finishGate;
      if (!response.writableEnded) chunk(response, 'MAIN_DONE', 'stop');
    }
  } else chunk(response, 'Fixture reply.', 'stop');
});
await new Promise<void>((resolve) => provider.listen(4848, '127.0.0.1', resolve));
let server: Awaited<ReturnType<typeof startIsolatedServer>> | undefined;
const browser = await chromium.launch({ executablePath: process.env.BTW_CHROME_EXECUTABLE, headless: true,
  args: ['--disable-features=MacAppCodeSignClone'] });
const page = await browser.newPage({ viewport: { width: 1800, height: 1040 } });
const errors: string[] = [];
const permissionWrites: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('request', (request) => {
  if (request.method() === 'PUT' && request.url().includes('/permission-auto-accept/sessions/')) permissionWrites.push(new URL(request.url()).pathname.split('/').at(-1)!);
});
let delayImport = false;
let importWaiting = false;
let releaseImport: (() => void) | undefined;
let failContext = false;
let failFirstPrompt = process.argv.includes('--fail-first');
const importGate = new Promise<void>((resolve) => { releaseImport = resolve; });
await page.route('**/*', async (route) => {
  const request = route.request();
  const pathname = new URL(request.url()).pathname;
  if (failFirstPrompt && request.method() === 'POST' && pathname.endsWith('/prompt') && request.postData()?.includes('LIVE_SIDE_FIRST')) {
    failFirstPrompt = false;
    await route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"Synthetic first-send refusal"}' });
    return;
  }
  if (failContext && request.method() === 'GET' && pathname.endsWith('/context')) {
    failContext = false;
    await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Reference temporarily unavailable"}' });
    return;
  }
  if (delayImport && request.method() === 'POST' && pathname.endsWith('/import')) {
    delayImport = false;
    importWaiting = true;
    await importGate;
  }
  await route.continue();
});

try {
  server = await startIsolatedServer({ repo, dist, state: join(root, 'state'), project, port: 4849, fixturePort: 4848, logFile: join(root, 'server.log') });
  const sdk = OpenCode.make({ baseUrl: 'http://localhost:4849', headers: { 'x-opencode-directory': encodeURIComponent(project) } });
  await sdk.model.list();
  const pins = { notes: ['synthetic-note-for-prefix'], plans: [] };
  const parent = await sdk.session.create({ location: { directory: project }, title: 'Live BTW main task', metadata: { openchamber: { project_context_pins: pins } },
    agent: 'build', model: { providerID: 'perf', id: 'stream-300cps' } });
  await sdk.experimental.session.instructions.entry.put({ sessionID: parent.id, key: 'live-proof', value: 'KEEP_CUSTOM_PREFIX unchanged.' });
  await sdk.experimental.session.instructions.entry.put({ sessionID: parent.id, key: 'openchamber.pinned', value: 'PINNED_MAIN_REFERENCE unchanged.' });
  const firstQuestion = 'LIVE_SIDE_FIRST: what is the current progress?';
  if (coldSource) {
    await sdk.session.prompt({ sessionID: parent.id, text: 'COLD_MAIN_SETUP' });
    await sdk.experimental.session.wait({ sessionID: parent.id });
    await writeFile(join(project, 'opencode.json'), JSON.stringify({ plugins: [resolve('plugin')] }));
    await expect.poll(async () => {
      try { return (await sdk.rpc(LIVE_BTW_RPC).status({}, { location: { directory: project } })).version; }
      catch { return null; }
    }, { timeout: 15_000 }).toBe(2);
    await page.goto(`http://localhost:4849/?session=${parent.id}`);
    await expect(page.locator('[data-chat-column="main"]').getByText('COLD_MAIN_SETUP', { exact: true })).toBeVisible({ timeout: 30_000 });
    const editor = page.locator('[data-chat-column="main"] .cm-content');
    await editor.click();
    await page.keyboard.insertText(`/live-btw ${firstQuestion}`);
    await page.keyboard.press('Enter');
    await expect(page.getByText('live-btw.reserve failed: Wait for the main chat to make its next model request after enabling BTW, then send the side question again.', { exact: true })).toBeVisible();
    await expect(editor).toHaveText(firstQuestion);
    await page.screenshot({ path: join(output, 'live-btw-cold-source.png') });
  }
  await sdk.session.prompt({ sessionID: parent.id, text: 'LIVE_MAIN_TASK. Work through the steps and report progress.' });
  if (before) { advanceMain?.(); finishMain?.(); await sdk.experimental.session.wait({ sessionID: parent.id }); }
  if (!coldSource) await page.goto(`http://localhost:4849/?session=${parent.id}`);
  const main = page.locator('[data-chat-column="main"]');
  const side = page.locator('[data-chat-column="pinned"]');
  const sideText = (text: string) => side.locator('p:visible').filter({ hasText: text });
  await expect(main.getByText(/MAIN_PREMISE_ONE/).first()).toBeVisible({ timeout: 30_000 });
  await main.locator('.cm-content').click();
  if (!coldSource) await page.keyboard.insertText(`/live-btw ${firstQuestion}`);
  await page.keyboard.press('Enter');
  if (before) {
    await expect.poll(() => requests.some((entry) => JSON.stringify(entry.messages).includes('/live-btw'))).toBe(true);
    expect(await side.count()).toBe(0);
    console.log('Before: /live-btw reaches the main model as plain text and opens no side conversation.');
  } else {
    await expect(side).toBeVisible({ timeout: 30_000 });
    if (process.argv.includes('--fail-first')) {
      await expect(side.locator('.cm-content')).toHaveText(firstQuestion);
      const preparedBeforeRetry = await side.getAttribute('data-chat-session-id');
      const rootBeforeRetry = (await sdk.session.get({ sessionID: preparedBeforeRetry })).metadata.openchamber.btwLiveRootSessionID;
      await side.locator('.cm-content').click();
      await page.keyboard.press('Enter');
      await expect(side).not.toHaveAttribute('data-chat-session-id', preparedBeforeRetry);
      const afterRetry = await side.getAttribute('data-chat-session-id');
      expect((await sdk.session.get({ sessionID: afterRetry })).metadata.openchamber.btwLiveRootSessionID).toBe(rootBeforeRetry);
    }
    await expect(sideText('FIRST_FORMAL_ANSWER: The main task is still running.')).toBeVisible({ timeout: 30_000 });
    await expect(sideText(firstQuestion)).toBeVisible();
    expect(await side.getByText('LIVE_MAIN_TASK. Work through the steps and report progress.', { exact: true }).count()).toBe(0);
    expect(await side.getByText('MAIN_PREMISE_ONE', { exact: true }).count()).toBe(0);
    const firstSessionID = await side.getAttribute('data-chat-session-id');
    if (!firstSessionID) throw new Error('The first live conversation has no session ID.');
    const rootSessionID = (await sdk.session.get({ sessionID: firstSessionID })).metadata.openchamber.btwLiveRootSessionID;
    const permissionButton = side.getByRole('button', { name: /^Permissions:/ });
    const writesBeforeChoice = permissionWrites.length;
    const permissionBefore = await permissionButton.getAttribute('aria-label');
    await permissionButton.click();
    await expect.poll(() => permissionWrites.length).toBeGreaterThan(writesBeforeChoice);
    expect(permissionWrites.at(-1)).toBe(rootSessionID);
    await expect(permissionButton).not.toHaveAttribute('aria-label', permissionBefore!);
    const selectedPermission = await permissionButton.getAttribute('aria-label');
    const firstNative = await sdk.session.context({ sessionID: firstSessionID });
    const firstBasis = firstNative.find((message) => message.metadata?.openchamberLiveBtwEnd)?.metadata?.openchamberLiveBtwBasis;
    expect(firstBasis).toMatchObject({ completed: true });
    expect(firstBasis.text).toContain('MAIN_PREMISE_ONE');
    advanceMain?.();
    await expect(main.getByText(/MAIN_PREMISE_TWO/).first()).toBeVisible();
    await expect.poll(() => mainCalls).toBe(3);
    const parentWire = requests.filter((entry) => !JSON.stringify(entry.messages).includes('LIVE_SIDE_FIRST')).at(-1)!;
    const secondQuestion = 'LIVE_SIDE_SECOND: what changed since my first question?';
    delayImport = true;
    await side.locator('.cm-content').click();
    await page.keyboard.insertText(secondQuestion);
    await page.keyboard.press('Enter');
    await expect.poll(() => importWaiting).toBe(true);
    await side.locator('.cm-content').click();
    await page.keyboard.insertText('DRAFT_TYPED_DURING_PREPARATION');
    releaseImport?.();
    await expect(sideText('SECOND_FORMAL_ANSWER: The main session has new progress.')).toBeVisible({ timeout: 30_000 });
    await expect(side.locator('.cm-content')).toHaveText('DRAFT_TYPED_DURING_PREPARATION');
    const sideBounds = await side.boundingBox();
    await page.mouse.move(sideBounds!.x + sideBounds!.width / 2, sideBounds!.y + 200);
    await page.mouse.wheel(0, -2000);
    await expect(sideText(firstQuestion)).toBeVisible();
    await expect(sideText('FIRST_FORMAL_ANSWER: The main task is still running.')).toBeVisible();
    expect(await sideText('FIRST_SIDE_WORK_SHOULD_DROP').count()).toBe(0);
    expect(await side.getByText('LIVE_MAIN_TASK. Work through the steps and report progress.', { exact: true }).count()).toBe(0);
    const currentHead = await side.getAttribute('data-chat-session-id');
    await expect(permissionButton).toHaveAttribute('aria-label', selectedPermission!);
    expect(currentHead).not.toBe(firstSessionID);
    const sideWire = requests.find((entry) => JSON.stringify(entry.messages).includes('LIVE_SIDE_SECOND'))!;
    const inheritedPrefix = JSON.stringify(sideWire.messages.slice(0, parentWire.messages.length));
    const parentPrefix = JSON.stringify(parentWire.messages);
    const { messages: parentMessages, ...parentOptions } = parentWire;
    const { messages: sideMessages, ...sideOptions } = sideWire;
    expect(inheritedPrefix).toBe(parentPrefix);
    expect(sideOptions).toEqual(parentOptions);
    const tail = JSON.stringify(sideWire.messages.slice(parentWire.messages.length));
    expect(parentPrefix).toContain('MAIN_PREMISE_TWO');
    expect(tail).toContain('FIRST_FORMAL_ANSWER');
    expect(tail).toContain('LIVE_SIDE_FIRST');
    expect(tail).toContain('MAIN_PREMISE_ONE');
    expect(tail).not.toContain('FIRST_SIDE_WORK_SHOULD_DROP');
    expect(tail).not.toContain('side-inspection');
    expect(tail).not.toContain('DRAFT_TYPED_DURING_PREPARATION');
    const endIndex = sideWire.messages.findIndex((message) => JSON.stringify(message).includes('</live-btw-prompt-end>'));
    const questionIndex = sideWire.messages.findIndex((message) => JSON.stringify(message).includes('LIVE_SIDE_SECOND'));
    expect(questionIndex).toBeGreaterThan(endIndex);
    const finalNative = await sdk.session.context({ sessionID: currentHead! });
    const oldPremises = finalNative.filter((message) => message.metadata?.openchamberLiveBtwBasis && !message.metadata?.openchamberLiveBtwEnd);
    expect(oldPremises[0]?.metadata?.openchamberLiveBtwBasis).toEqual(firstBasis);
    const oldRoot = await sdk.session.get({ sessionID: rootSessionID });
    expect(oldRoot.metadata?.openchamber?.btwLiveHeadSessionID).toBe(currentHead);
    expect((await sdk.session.get({ sessionID: currentHead! })).parentID).toBe(rootSessionID);
    expect((await sdk.session.get({ sessionID: currentHead! })).metadata?.openchamber?.project_context_pins).toEqual(pins);
    expect(parentPrefix).toContain('PINNED_MAIN_REFERENCE');
    expect(new URL(page.url()).searchParams.get('session')).toBe(parent.id);
    await page.reload();
    await expect(sideText('SECOND_FORMAL_ANSWER: The main session has new progress.')).toBeVisible({ timeout: 30_000 });
    await expect(side.locator('.cm-content')).toHaveText('DRAFT_TYPED_DURING_PREPARATION');
    const requestsBeforeFailure = requests.length;
    failContext = true;
    await side.locator('.cm-content').click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.insertText('LIVE_SIDE_FAILURE: keep the previous conversation.');
    await page.keyboard.press('Enter');
    await expect(side.locator('.cm-content')).toHaveText('LIVE_SIDE_FAILURE: keep the previous conversation.', { timeout: 15_000 });
    expect(await side.getAttribute('data-chat-session-id')).toBe(currentHead);
    await expect(sideText('SECOND_FORMAL_ANSWER: The main session has new progress.')).toBeVisible();
    expect(requests.length).toBe(requestsBeforeFailure);
    await page.goto(`http://localhost:4849/?session=${currentHead}`);
    await expect(sideText('SECOND_FORMAL_ANSWER: The main session has new progress.')).toBeVisible({ timeout: 30_000 });
    await side.locator('.cm-content').click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.insertText('LIVE_SIDE_THIRD: continue from this session link.');
    await page.keyboard.press('Enter');
    await expect(sideText('THIRD_FORMAL_ANSWER: The live conversation remains connected.')).toBeVisible({ timeout: 30_000 });
    await expect(sideText(firstQuestion)).toBeVisible();
    await expect(sideText(secondQuestion)).toBeVisible();
    expect(Object.hasOwn(await sdk.session.active(), parent.id)).toBe(true);
    await page.screenshot({ path: join(output, 'live-btw-conversation.png'), animations: 'disabled' });
    const requestsBeforeEmpty = requests.length;
    const thirdHead = await side.getAttribute('data-chat-session-id');
    await main.locator('.cm-content').click();
    await page.keyboard.insertText('/live-btw');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
    await expect(side).not.toHaveAttribute('data-chat-session-id', thirdHead!);
    await expect(side.locator('.cm-content')).toBeFocused();
    expect(requests.length).toBe(requestsBeforeEmpty);
    expect(await side.locator('p:visible').filter({ hasText: 'LIVE_MAIN_TASK' }).count()).toBe(0);
    expect(errors).toEqual([]);
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const proof = { firstRunningMainSnapshot: 'passed', inheritedHistoryHidden: 'passed', latestMainSnapshotOnSecondQuestion: 'passed',
      originalPremiseRetained: 'passed', sideWorkExcludedFromReplay: 'passed', finalAnswersAndUserPromptsRetained: 'passed',
      sameLogicalTab: 'passed', draftDuringPreparation: 'passed', reload: 'passed', failedSnapshotPreservesConversation: 'passed',
      reopenHeadLinkAndSendThirdQuestion: 'passed', inheritedPinsPreserved: 'passed',
      emptyLiveChatDoesNotCallModel: 'passed', mainTaskRemainsRunning: true,
      permissionChoiceFollowsLogicalRoot: 'passed',
      ...(coldSource ? { coldSourceShowsReason: true, coldSourcePreservesQuestion: true, coldSourceRetryAfterMainRequest: true } : {}),
      ...(process.argv.includes('--fail-first') ? { firstSendFailureReusesRoot: 'passed' } : {}),
      unchangedMainPrefix: inheritedPrefix === parentPrefix, parentPrefixSha256: hash(parentPrefix), inheritedPrefixSha256: hash(inheritedPrefix),
      sameRequestOptionsAndTools: true, customInstructionEntryPreserved: parentPrefix.includes('KEEP_CUSTOM_PREFIX'),
      newQuestionAfterClosingMarker: true, scope: 'Real OpenCode and native UI with a deterministic provider and synthetic conversations.', errors };
    await writeFile(join(output, 'live-btw-proof.json'), JSON.stringify(proof, null, 2));
    await writeFile(join(output, 'live-btw-wire-requests.json'), JSON.stringify({ parent: parentWire, side: sideWire }, null, 2));
    console.log(JSON.stringify(proof, null, 2));
  }
  await page.screenshot({ path: join(output, `live-btw-${before ? 'before' : 'after'}.png`), animations: 'disabled' });
} catch (error) {
  await page.screenshot({ path: join(output, 'live-btw-debug.png'), animations: 'disabled' });
  console.error(error instanceof Error ? error.message : error);
  console.error('Browser errors:', errors);
  console.error((await page.locator('body').innerText()).slice(-5000));
  console.error('Side scroll state:', await page.locator('[data-chat-column="pinned"] [data-scrollbar="chat"]').evaluateAll((nodes) => nodes.map((node) => ({ top: node.scrollTop, height: node.scrollHeight, client: node.clientHeight }))));
  await writeFile(join(output, 'live-btw-debug-requests.json'), JSON.stringify(requests, null, 2));
  process.exitCode = 1;
} finally {
  releaseImport?.();
  advanceMain?.();
  finishMain?.();
  await browser.close();
  if (server) await server.stop();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
}
