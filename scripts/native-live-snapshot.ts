import { createServer, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = resolve(process.env.BTW_HOST_DIR ?? '../openchamber');
const { chromium, expect } = await import(process.env.BTW_PLAYWRIGHT_MODULE ?? '@playwright/test');
const { OpenCode } = await import(pathToFileURL(join(repo, 'node_modules/@opencode/client/dist/promise/index.js')).href);
const { startIsolatedServer } = await import(pathToFileURL(join(repo, 'scripts/perf/isolated-server.mjs')).href);
const dist = process.env.BTW_PROOF_DIST ?? `${repo}/packages/web/dist`;
const output = resolve(process.env.BTW_OUTPUT_DIR ?? join(tmpdir(), 'ob-btw-verification'));
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(output, 'snapshot-'));
const project = join(root, 'project');
await mkdir(project, { recursive: true });
const before = process.argv.includes('--before');
const agentBefore = process.argv.includes('--agent-before');
const progress = 'PROGRESS_STEP_1 completed: inspected the settings. PROGRESS_STEP_2 running: checking the cache.';
const lateProgress = 'PROGRESS_STEP_3 completed: later work after the first fork.';
const sideRequests: string[] = [];
const wireRequests: Array<{ model: string; messages: unknown[]; tools: unknown[]; options: Record<string, unknown> }> = [];
let mainResponse: ServerResponse | null = null;
let resolveMain: (() => void) | undefined;
const gate = new Promise<void>((resolve) => { resolveMain = resolve; });
let advanceMain: (() => void) | undefined;
const advanceGate = new Promise<void>((resolve) => { advanceMain = resolve; });
let mainCalls = 0;
const chunk = (response: ServerResponse, text: string, finish = false) => {
    response.write(`data: ${JSON.stringify({ id: 'chatcmpl-live-snapshot', object: 'chat.completion.chunk', created: 1, model: 'fixture',
        choices: [{ index: 0, delta: finish ? {} : { content: text }, finish_reason: finish ? 'stop' : null }] })}\n\n`);
    if (finish) response.end('data: [DONE]\n\n');
};
const finishTool = (response: ServerResponse, text: string, step: number) => {
    chunk(response, `${text}\n\n`);
    response.write(`data: ${JSON.stringify({ id: 'chatcmpl-live-snapshot', object: 'chat.completion.chunk', created: 1, model: 'fixture',
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call-progress-${step}`, type: 'function', function: { name: 'glob', arguments: JSON.stringify({ pattern: '*.md' }) } }] }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: 'chatcmpl-live-snapshot', object: 'chat.completion.chunk', created: 1, model: 'fixture',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 10, total_tokens: 11 } })}\n\n`);
    response.end('data: [DONE]\n\n');
};
const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const part of request) chunks.push(Buffer.from(part));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const messages = JSON.stringify(body.messages);
    const { messages: messageInput, ...options } = body;
    wireRequests.push({ model: body.model, messages: messageInput, tools: body.tools ?? [], options });
    console.log(JSON.stringify({ request: request.url, stream: body.stream, parent: messages.includes('LIVE_MAIN_TASK'), side: messages.includes('LIVE_SIDE_QUESTION') }));
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    response.flushHeaders();
    response.write(`data: ${JSON.stringify({ id: 'chatcmpl-live-snapshot', object: 'chat.completion.chunk', created: 1, model: body.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`);
    if (messages.includes('LIVE_SIDE_QUESTION')) {
        sideRequests.push(messages);
        chunk(response, messages.includes('PROGRESS_STEP_2') ? 'Step 1 is complete. Step 2 is running.' : 'The latest progress is missing.');
        chunk(response, '', true);
    } else if (messages.includes('LIVE_MAIN_TASK')) {
        mainCalls += 1;
        mainResponse = response;
        if (mainCalls === 1) finishTool(response, progress, 1);
        else if (mainCalls === 2) {
            await advanceGate;
            if (!response.writableEnded) finishTool(response, lateProgress, 2);
        } else {
            await gate;
            if (!response.writableEnded) chunk(response, '', true);
        }
    } else {
        chunk(response, 'Fixture reply.');
        chunk(response, '', true);
    }
});
await new Promise<void>((resolve) => provider.listen(4848, '127.0.0.1', resolve));
await mkdir(root, { recursive: true });
let server: Awaited<ReturnType<typeof startIsolatedServer>> | undefined;
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
    args: ['--disable-features=MacAppCodeSignClone'] });
const page = await browser.newPage({ viewport: { width: 1800, height: 1040 } });
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
    server = await startIsolatedServer({ repo, dist, state: `${root}/state`, project,
        port: 4849, fixturePort: 4848, logFile: `${root}/server.log` });
    const sdk = OpenCode.make({ baseUrl: 'http://localhost:4849', headers: { 'x-opencode-directory': encodeURIComponent(project) } });
    const parent = await sdk.session.create({ location: { directory: project }, title: 'Live progress snapshot proof',
        agent: 'build', model: { providerID: 'perf', id: 'stream-300cps' } });
    await sdk.session.prompt({ sessionID: parent.id, text: 'LIVE_MAIN_TASK. Work through the steps and report progress.' });
    await page.goto(`http://localhost:4849/?session=${parent.id}`);
    const main = page.locator('[data-chat-column="main"]');
    const editor = main.locator('.cm-content');
    await expect(main.getByText(/PROGRESS_STEP_2 running/).first()).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => mainCalls).toBe(2);
    const parentMessages = await sdk.message.list({ sessionID: parent.id, limit: 100, order: 'asc' });
    const direct = await sdk.session.fork({ sessionID: parent.id });
    const forkMessages = await sdk.message.list({ sessionID: direct.id, limit: 100, order: 'asc' });
    await writeFile(`${output}/native-btw-live-records.json`, JSON.stringify({ parent: parentMessages.data, fork: forkMessages.data }, null, 2));
    const sourceIDs = parentMessages.data.map((entry) => entry.id);
    const clonedIDs = forkMessages.data.map((entry) => entry.id);
    const directProof = { inheritedPartialProgress: JSON.stringify(forkMessages).includes('PROGRESS_STEP_2'),
        sourceIDs, clonedIDs, inheritedIDsPreserved: JSON.stringify(sourceIDs) === JSON.stringify(clonedIDs) };
    console.log(JSON.stringify({ directFork: directProof }));
    await editor.click();
    await page.keyboard.insertText('/btw LIVE_SIDE_QUESTION: where are we now?');
    await page.keyboard.press('Enter');
    if (before) {
        await expect(page.getByText('No completed turn to fork from', { exact: true })).toBeVisible();
        console.log('Before: the UI rejects a first running turn even though the server can fork its partial progress.');
        await writeFile(`${output}/native-btw-live-before.json`, JSON.stringify(directProof, null, 2));
    } else {
        const side = page.locator('[data-chat-column="pinned"]');
        await expect(side).toBeVisible({ timeout: 20_000 });
        await expect(side.getByText('Step 1 is complete. Step 2 is running.', { exact: true })).toBeVisible();
        await expect(side.locator('.cm-content')).toBeFocused();
        expect(sideRequests.at(-1)).toContain('PROGRESS_STEP_2');
        expect(mainResponse?.writableEnded).toBe(false);
        const firstSideId = await side.getAttribute('data-chat-session-id');
        if (!firstSideId) throw new Error('Missing native side session');
        const firstSnapshot = await sdk.message.list({ sessionID: firstSideId, limit: 100, order: 'asc' });
        expect(JSON.stringify(firstSnapshot)).toContain('PROGRESS_STEP_2');
        const firstSession = await sdk.session.get({ sessionID: firstSideId });
        const parentSession = await sdk.session.get({ sessionID: parent.id });
        const sideRequestIndex = wireRequests.findIndex((entry) => JSON.stringify(entry.messages).includes('LIVE_SIDE_QUESTION'));
        const sideWire = wireRequests[sideRequestIndex]!;
        const parentWire = wireRequests.slice(0, sideRequestIndex).filter((entry) => !JSON.stringify(entry.messages).includes('LIVE_SIDE_QUESTION')).at(-1)!;
        let commonPrefixMessages = 0;
        while (commonPrefixMessages < parentWire.messages.length && JSON.stringify(parentWire.messages[commonPrefixMessages]) === JSON.stringify(sideWire.messages[commonPrefixMessages])) commonPrefixMessages += 1;
        const parentPrefix = JSON.stringify(parentWire.messages);
        const childPrefix = JSON.stringify(sideWire.messages.slice(0, parentWire.messages.length));
        const differingOptionKeys = [...new Set([...Object.keys(parentWire.options), ...Object.keys(sideWire.options)])]
            .filter((key) => JSON.stringify(parentWire.options[key]) !== JSON.stringify(sideWire.options[key]));
        const readOnlyMessageIndex = sideWire.messages.findIndex((message) => JSON.stringify(message).includes('This BTW side conversation is read-only.'));
        const agentProof = { parentAgent: parentSession.agent, sideAgent: firstSession.agent,
            sameModel: JSON.stringify(parentSession.model) === JSON.stringify(firstSession.model),
            sameToolDefinitions: createHash('sha256').update(JSON.stringify(parentWire.tools)).digest('hex') === createHash('sha256').update(JSON.stringify(sideWire.tools)).digest('hex'),
            parentMessageCount: parentWire.messages.length, commonPrefixMessages,
            parentPrefixSha256: createHash('sha256').update(parentPrefix).digest('hex'),
            inheritedPrefixSha256: createHash('sha256').update(childPrefix).digest('hex'),
            unchangedParentPrefix: parentPrefix === childPrefix,
            differingOptionKeys, readOnlyMessageIndex,
            readOnlyInstructionPresent: sideRequests.at(-1)!.includes('This BTW side conversation is read-only.') };
        console.log(JSON.stringify({ agentProof }));
        await writeFile(`${output}/native-btw-agent-${agentBefore ? 'before' : 'after'}.json`, JSON.stringify(agentProof, null, 2));
        if (!agentBefore) {
            expect(agentProof.sideAgent).toBe(agentProof.parentAgent);
            expect(agentProof.sameModel).toBe(true);
            expect(agentProof.sameToolDefinitions).toBe(true);
            expect(agentProof.unchangedParentPrefix).toBe(true);
            expect(agentProof.differingOptionKeys).toEqual([]);
            expect(agentProof.readOnlyInstructionPresent).toBe(true);
            expect(agentProof.readOnlyMessageIndex).toBeGreaterThanOrEqual(agentProof.parentMessageCount);
        }
        expect(firstSession.metadata?.openchamber?.btwSnapshotAt).toBe(firstSession.time.created);
        await expect(side.locator('[data-btw-context-boundary]')).toContainText('Snapshot at');
        if (!agentBefore) {
        const followupEditor = side.locator('.cm-content');
        await followupEditor.click();
        await page.keyboard.insertText('LIVE_SIDE_QUESTION_FOLLOWUP: explain the current progress without changes.');
        await page.keyboard.press('Enter');
        await expect.poll(() => sideRequests.length).toBe(2);
        const followupWire = wireRequests.filter((entry) => JSON.stringify(entry.messages).includes('LIVE_SIDE_QUESTION_FOLLOWUP')).at(-1)!;
        const followupProof = {
            unchangedParentPrefix: JSON.stringify(followupWire.messages.slice(0, parentWire.messages.length)) === parentPrefix,
            unchangedPreviousSideRequestPrefix: JSON.stringify(followupWire.messages.slice(0, sideWire.messages.length)) === JSON.stringify(sideWire.messages),
            sameToolDefinitions: JSON.stringify(followupWire.tools) === JSON.stringify(parentWire.tools),
            unchangedOptions: JSON.stringify(followupWire.options) === JSON.stringify(parentWire.options),
            readOnlyReminderPresent: followupWire.messages.slice(sideWire.messages.length)
                .some((message) => JSON.stringify(message).includes('This BTW side conversation is read-only.')),
        };
        console.log(JSON.stringify({ followupProof }));
        await writeFile(`${output}/native-btw-agent-after.json`, JSON.stringify({ ...agentProof, followup: followupProof }, null, 2));
        await writeFile(`${output}/native-btw-agent-wire.json`, JSON.stringify({
            scope: 'Synthetic fixture requests from real OpenCode and the native OpenChamber UI. No production conversations.',
            parent: parentWire, side: sideWire, followup: followupWire,
        }, null, 2));
        expect(Object.values(followupProof).every(Boolean)).toBe(true);
        advanceMain?.();
        await expect(main.getByText(/PROGRESS_STEP_3 completed/).first()).toBeVisible();
        await expect.poll(() => mainCalls).toBe(3);
        expect(JSON.stringify(await sdk.message.list({ sessionID: firstSideId, limit: 100, order: 'asc' }))).not.toContain('PROGRESS_STEP_3');
        await editor.click();
        await page.keyboard.press('Meta+Alt+s');
        await expect(side).not.toHaveAttribute('data-chat-session-id', firstSideId);
        const secondSideId = await side.getAttribute('data-chat-session-id');
        expect(JSON.stringify(await sdk.message.list({ sessionID: secondSideId!, limit: 100, order: 'asc' }))).toContain('PROGRESS_STEP_3');
        expect((await sdk.session.get({ sessionID: secondSideId! })).agent).toBe(parentSession.agent);
        await expect(side.getByText('Build', { exact: true }).last()).toBeVisible();
        expect(mainResponse?.writableEnded).toBe(false);
        expect(new URL(page.url()).searchParams.get('session')).toBe(parent.id);
        expect(errors).toEqual([]);
        const result = { ...directProof, firstRunningTurnSideQuestion: 'passed', latestSnapshotOnNextFork: 'passed',
            oldSnapshotDoesNotFollowParent: 'passed', mainTaskRemainsRunning: true, nativeFocus: 'passed', errors };
        await writeFile(`${output}/native-btw-live-after.json`, JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result, null, 2));
        }
    }
    await page.screenshot({ path: `${output}/native-btw-live-${before ? 'before' : 'after'}.png`, animations: 'disabled' });
} catch (error) {
    await page.screenshot({ path: `${output}/native-btw-live-debug.png`, animations: 'disabled' });
    console.error(error);
    console.error('Browser errors:', errors);
    console.error((await page.locator('body').innerText()).slice(-4000));
    process.exitCode = 1;
} finally {
    advanceMain?.();
    resolveMain?.();
    await browser.close();
    if (server) await server.stop();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
}
