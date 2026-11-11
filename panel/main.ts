import { connectHost, type GuestSessionRecord } from '@openchamber/sdk';
import { applyHostReady, mountBanner, mountButton, mountEmpty, mountList, type BannerHandle, type ListHandle } from '@openchamber/sdk/ui';

const host = connectHost();
const actions = document.querySelector('#actions')!;
const sessions = document.querySelector('#sessions')!;
const notices = document.querySelector('#notice')!;
let banner: BannerHandle | null = null;
let list: ListHandle | null = null;
let directory: string | null = null;
let generation = 0;
let unsubscribe: (() => void) | null = null;
let legacy: { sessionId: string; title: string; sourceTitle?: string }[] = [];
let native: GuestSessionRecord[] = [];

function showError(error: unknown) {
  banner?.dispose();
  banner = mountBanner(notices, { tone: 'error', title: error instanceof Error ? error.message : '无法打开会话。请重试。' });
}

async function openNative(sessionId: string) {
  try { await host.openSession(sessionId, { navigation: 'side' }); }
  catch (error) { showError(error); }
}

mountButton(actions, { label: '刷新', variant: 'ghost', size: 'sm', onClick: () => void load() });

function paint() {
  list?.dispose(); list = null; sessions.replaceChildren();
  const records = new Map<string, { title: string; subtitle: string }>();
  for (const thread of legacy) records.set(thread.sessionId, { title: thread.title, subtitle: thread.sourceTitle ?? '已有 BTW' });
  for (const thread of native) records.set(thread.id, { title: thread.title, subtitle: '原生 BTW 会话' });
  if (!records.size) {
    mountEmpty(sessions, { title: '用 /btw 打开原生侧栏聊天', body: '可同时打开多个聊天标签。已有会话的记录保留在 OpenChamber 中。' });
    return;
  }
  list = mountList(sessions, {
    items: [...records].map(([id, value]) => ({ id, ...value })),
    ariaLabel: 'BTW 会话', onSelect: (id) => void openNative(id),
  });
}

async function load() {
  const revision = ++generation;
  const scope = directory;
  unsubscribe?.(); unsubscribe = null;
  if (!scope) { paint(); return; }
  try {
    const result = await host.serviceRequest({ method: 'GET', path: '/sessions', query: { directory: scope } });
    const content = JSON.parse(result.body);
    if (result.status !== 200) throw new Error(content.error ?? '无法读取已有 BTW。');
    if (revision !== generation) return;
    legacy = content.sessions;
    const projects = await host.listProjects();
    if (revision !== generation) return;
    const project = projects.projects.filter((entry) => scope === entry.directory || scope.startsWith(`${entry.directory}/`))
      .sort((left, right) => right.directory.length - left.directory.length)[0];
    if (project) {
      const stop = await host.onSessions(project.id, (snapshot) => {
        if (revision !== generation || snapshot.kind !== 'sessions') return;
        native = snapshot.sessions.filter((entry) => !entry.archivedAt && /^(?:live-)?btw(?::|$)/i.test(entry.title));
        paint();
      });
      if (revision !== generation) stop();
      else unsubscribe = stop;
    }
    paint();
  } catch (error) { if (revision === generation) showError(error); }
}

host.onReady((next) => {
  applyHostReady(next, document.documentElement);
  if (!next.features?.sideChat) {
    showError(new Error('此宿主尚未提供扩展调用原生侧边聊天的接口。请先应用随附的宿主补丁。现有聊天可从会话菜单选择「在侧边面板中打开」。'));
    return;
  }
  if (directory === next.directory) return;
  directory = next.directory;
  legacy = []; native = [];
  void load();
});

window.addEventListener('pagehide', () => { unsubscribe?.(); host.dispose(); });
