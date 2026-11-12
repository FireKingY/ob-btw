import { expect, test } from 'bun:test';
import type { GuestSessionRecord } from '@openchamber/sdk';
import { isListedBtw, readLegacySessions } from './sessions';
const session = (title: string): GuestSessionRecord => ({ id: 'root', title, projectId: 'project', directory: '/project',
  parentId: null, createdAt: 1, updatedAt: 1, archivedAt: null, worktree: null, activity: 'idle', outcome: null, items: [] });
test('explicit identity survives rename and excludes native context heads and title lookalikes', () => {
  expect(isListedBtw({ ...session('Custom title'), btw: { mode: 'live', rootSessionID: 'root' } }, true)).toBe(true);
  expect(isListedBtw({ ...session('Custom title'), id: 'head', btw: { mode: 'live', rootSessionID: 'root' } }, true)).toBe(false);
  expect(isListedBtw(session('btw: ordinary conversation'), true)).toBe(false);
  expect(isListedBtw(session('btw: older host'), false)).toBe(true);
});
test('legacy parsing preserves valid rows and rejects a broken source independently', () => {
  expect(readLegacySessions({ sessions: [null, { sessionId: 'old', title: 'Older BTW' }, { sessionId: 1, title: 'bad' }] }))
    .toEqual([{ sessionId: 'old', title: 'Older BTW' }]);
  expect(() => readLegacySessions({ error: 'Unreadable file' })).toThrow();
});
