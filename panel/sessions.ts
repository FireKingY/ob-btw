import type { GuestSessionRecord } from '@openchamber/sdk';

export type LegacyThread = { sessionId: string; title: string; sourceTitle?: string };
export function readLegacySessions(value: unknown): LegacyThread[] {
  if (!value || typeof value !== 'object' || !('sessions' in value) || !Array.isArray(value.sessions)) throw new Error('已有 BTW 列表格式无效。');
  return value.sessions.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object' || !('sessionId' in item) || typeof item.sessionId !== 'string'
      || !('title' in item) || typeof item.title !== 'string') return [];
    return [{ sessionId: item.sessionId, title: item.title, ...('sourceTitle' in item && typeof item.sourceTitle === 'string' ? { sourceTitle: item.sourceTitle } : {}) }];
  });
}

export const isListedBtw = (entry: GuestSessionRecord, explicitMetadata: boolean): boolean => {
  if (entry.archivedAt) return false;
  if (explicitMetadata) return entry.btw?.rootSessionID === entry.id;
  return /^(?:live-)?btw(?::|$)/i.test(entry.title);
};
