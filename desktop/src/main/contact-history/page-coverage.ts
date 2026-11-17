import type { ContactHistoryMessage } from '../../shared/contact-history-bridge';

type HistoryPage = {
  before: string | null;
  messages: readonly ContactHistoryMessage[];
  nextCursor: string | null;
};

/** 只记录已读页面的游标与相邻边，不持有聊天正文或推测未读范围。 */
export class HistoryPageCoverage {
  private readonly pageCursors = new Map<string, string | null>();
  private readonly successors = new Map<string | null, string | null>();

  clear(): void { this.pageCursors.clear(); this.successors.clear(); }

  beforeMessage(messageId: string): string | null { return this.pageCursors.get(messageId) ?? null; }

  accept(previous: readonly ContactHistoryMessage[], pages: readonly HistoryPage[]): string | null {
    const known = new Map(previous.map(message => [message.messageId, message]));
    const moved = new Set<string>();
    for (const page of pages) for (const message of page.messages) {
      const old = known.get(message.messageId);
      if (old && (old.occurredAt !== message.occurredAt || old.displayPosition !== message.displayPosition)) {
        moved.add(message.messageId);
      }
    }
    // 时间补齐会改变分页顺序；先撤销旧位置的入边与出边，再接纳本次实际读取的页面。
    if (moved.size) for (const [before, after] of this.successors) {
      if (before !== null && moved.has(before) || after !== null && moved.has(after)) this.successors.delete(before);
    }
    for (const page of pages) this.recordPage(page);
    return this.nextUncoveredCursor();
  }

  private recordPage(page: HistoryPage): void {
    let cursor = page.before;
    for (const message of page.messages) {
      this.pageCursors.set(message.messageId, page.before);
      this.successors.set(cursor, message.messageId);
      cursor = message.messageId;
    }
    if (page.nextCursor !== cursor || page.nextCursor === null) this.successors.set(cursor, page.nextCursor);
    else if (this.successors.get(cursor) === null) {
      // 后端证明页尾仍有更早消息，原来“已到底”的结论已失效。
      this.successors.delete(cursor);
    }
  }

  private nextUncoveredCursor(): string | null {
    let cursor: string | null = null;
    const seen = new Set<string>();
    while (this.successors.has(cursor)) {
      const next: string | null = this.successors.get(cursor)!;
      if (next === null) return null;
      if (seen.has(next)) {
        this.successors.delete(cursor);
        return cursor;
      }
      seen.add(next);
      cursor = next;
    }
    return cursor;
  }
}
