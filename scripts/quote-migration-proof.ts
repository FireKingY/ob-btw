import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const repo = resolve(process.env.BTW_HOST_DIR ?? '../openchamber');
const { chromium, expect } = await import(process.env.BTW_PLAYWRIGHT_MODULE ?? '@playwright/test');
const { OpenCode } = await import(pathToFileURL(join(repo, 'node_modules/@opencode/client/dist/promise/index.js')).href);
const { startIsolatedServer } = await import(pathToFileURL(join(repo, 'scripts/perf/isolated-server.mjs')).href);
const output = resolve(process.env.BTW_OUTPUT_DIR ?? join(tmpdir(), 'ob-btw-verification'));
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(output, 'quote-migration-'));
const project = `${root}/project`;
await mkdir(project);
await writeFile(join(project, 'opencode.json'), JSON.stringify({ plugins: [resolve('plugin')] }));
const provider = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const content = JSON.stringify(body.messages).includes('QUOTE_SECOND') ? 'SECOND_ANSWER' : 'FIRST_ANSWER';
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ id: 'review', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'review', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise<void>((resolve) => provider.listen(4848, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: process.env.BTW_CHROME_EXECUTABLE, headless: true, args: ['--disable-features=MacAppCodeSignClone'] });
const page = await browser.newPage({ viewport: { width: 1800, height: 1040 } });
let server;
let delayed = false;
let waiting = false;
let release;
let phase = 'startup';
const gate = new Promise<void>((resolve) => { release = resolve; });
await page.route('**/*', async (route) => {
  if (delayed && route.request().method() === 'POST' && new URL(route.request().url()).pathname.endsWith('/import')) {
    delayed = false;
    waiting = true;
    await gate;
  }
  await route.continue();
});
try {
  server = await startIsolatedServer({ repo, dist: process.env.BTW_PROOF_DIST ?? join(repo, 'packages/web/dist'), state: `${root}/state`, project, port: 4849, fixturePort: 4848, logFile: `${root}/server.log` });
  const sdk = OpenCode.make({ baseUrl: 'http://localhost:4849', headers: { 'x-opencode-directory': encodeURIComponent(project) } });
  await sdk.model.list();
  const mainSession = await sdk.session.create({ location: { directory: project }, agent: 'build', model: { providerID: 'perf', id: 'stream-300cps' } });
  await sdk.session.prompt({ sessionID: mainSession.id, text: 'MAIN_REFERENCE' });
  await sdk.experimental.session.wait({ sessionID: mainSession.id });
  await page.goto(`http://localhost:4849/?session=${mainSession.id}`);
  const main = page.locator('[data-chat-column="main"]');
  const side = page.locator('[data-chat-column="pinned"]');
  await expect(main.locator('.cm-content')).toBeVisible({ timeout: 30_000 });
  await expect(main.getByText('MAIN_REFERENCE', { exact: true })).toBeVisible({ timeout: 30_000 });
  await main.locator('.cm-content').click();
  await page.keyboard.insertText('/live-btw QUOTE_FIRST');
  await page.keyboard.press('Enter');
  await expect(side.locator('p:visible').filter({ hasText: 'FIRST_ANSWER' })).toBeVisible({ timeout: 30_000 });
  const oldHead = await side.getAttribute('data-chat-session-id');
  await sdk.experimental.session.wait({ sessionID: oldHead! });
  const logicalRoot = (await sdk.session.get({ sessionID: oldHead! })).metadata.openchamber.btwLiveRootSessionID;
  await expect.poll(async () => (await sdk.session.get({ sessionID: logicalRoot })).metadata.openchamber.btwLiveLease).toBeNull();
  await expect(side.locator('.cm-content')).toBeFocused();
  const selectAnswer = async () => {
    phase = 'select answer';
    const paragraph = side.locator('p:visible').filter({ hasText: 'FIRST_ANSWER' });
    await paragraph.scrollIntoViewIfNeeded();
    await paragraph.click();
    await paragraph.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
  };
  const attachComment = async (text: string) => {
    await selectAnswer();
    await page.getByRole('button', { name: 'Comment', exact: true }).click();
    await page.keyboard.insertText(text);
    await page.getByRole('button', { name: 'Attach', exact: true }).click();
  };
  await attachComment('ALREADY_SENT_REFERENCE');
  delayed = true;
  await side.locator('.cm-content').click();
  await page.keyboard.insertText('QUOTE_SECOND');
  await page.keyboard.press('Enter');
  await expect.poll(() => waiting).toBe(true);
  await attachComment('NEW_DRAFT_DURING_PREPARATION');
  release();
  await expect(side.locator('p:visible').filter({ hasText: 'SECOND_ANSWER' })).toBeVisible({ timeout: 30_000 });
  const newHead = await side.getAttribute('data-chat-session-id');
  const comments = async (sessionID: string) => page.evaluate((id) => {
    const drafts = JSON.parse(localStorage.getItem('openchamber-inline-comment-drafts') ?? '{}').state?.drafts ?? {};
    return Object.entries(drafts).flatMap(([key, values]) => JSON.parse(key)[2] === id ? (values as Array<{ text: string }>).map((entry) => entry.text) : []);
  }, sessionID);
  await expect.poll(() => comments(logicalRoot)).toEqual(['NEW_DRAFT_DURING_PREPARATION']);
  expect(await comments(oldHead!)).toEqual([]);
  expect(await comments(newHead!)).toEqual([]);
  phase = 'selection insertion and undo';
  await selectAnswer();
  await expect(page.getByRole('button', { name: 'Comment', exact: true })).toBeVisible();
  await page.keyboard.press('Meta+l');
  await expect(side.locator('.cm-content')).toContainText('FIRST_ANSWER');
  await side.locator('.cm-content').fill('');
  await expect.poll(async () => (await sdk.session.get({ sessionID: logicalRoot })).metadata.openchamber.btwLiveLease).toBeNull();
  await side.getByRole('button', { name: 'Revert to this message', exact: true }).last().click({ force: true });
  await expect(side.locator('.cm-content')).toHaveText('QUOTE_SECOND');
  await expect.poll(async () => Boolean((await sdk.session.get({ sessionID: newHead })).revert)).toBe(true);
  const report = { nativeQuoteMigration: 'passed', sentReferenceNotRestored: true,
    newReferenceKeptOnLogicalRoot: true, executionDraftSlotsEmpty: true,
    selectedTextReachesLogicalComposer: true, undoRestoresLogicalComposer: true,
    scope: 'Native UI with real OpenCode and a deterministic provider.' };
  await writeFile(join(output, 'quote-migration-proof.json'), JSON.stringify(report, null, 2));
  await page.screenshot({ path: `${root}/after.png` });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(phase, error instanceof Error ? error.message : error);
  console.error('Selection:', await page.evaluate(() => ({ text: window.getSelection()?.toString(),
    focus: document.activeElement?.outerHTML.slice(0, 200), selectedParents: window.getSelection()?.anchorNode?.parentElement?.outerHTML.slice(0, 400) })));
  console.error((await page.locator('body').innerText()).slice(-2500));
  await page.screenshot({ path: `${root}/error.png` });
  process.exitCode = 1;
} finally {
  release();
  await browser.close();
  if (server) await server.stop();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
}
