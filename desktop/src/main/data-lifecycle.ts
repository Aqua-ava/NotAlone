import type { ContactHistoryController } from './contact-history/controller';
import type { MessageMediaController } from './media/controller';
import type { FixedMemoryProcessingController } from './memory/fixed-processing';
import type { SqliteMemoryManagementController } from './memory/sqlite-management';
import type { SqliteDiscussionController } from './reply/sqlite-discussion-bridge';
import type { ReplySession } from './reply/session';
import { currentDiagnosticTrace, diagnose, newTraceId, withDiagnosticTrace } from '../../../backend-ts/src/diagnostics/context';

const withdrawal = {
  'contact-deletion': { code: 'contact_deleted', notice: '联系人正在删除，旧聊天与资料已停用。' },
  'history-clear': { code: 'history_cleared', notice: '聊天记录正在清空，完成后可重新同步并刷新。' },
};
interface Dependencies {
  history: Pick<ContactHistoryController, 'invalidate' | 'refreshCurrent'>;
  media: Pick<MessageMediaController, 'invalidate' | 'invalidateAndDrain'>;
  processing: Pick<FixedMemoryProcessingController, 'synchronize'>;
  management: Pick<SqliteMemoryManagementController, 'synchronize'>;
  discussion: Pick<SqliteDiscussionController, 'synchronize'>;
  replies: Pick<ReplySession, 'prepareConnectionChange' | 'beginHistoryClear'>;
}

/** 统一撤下桌面资料，各控制器持有自己的操作代次、取消和晚到结果守卫。 */
export class DesktopDataLifecycle {
  constructor(private readonly ports: Dependencies) {}

  withdraw(reason: keyof typeof withdrawal): void {
    const { code, notice } = withdrawal[reason];
    withDiagnosticTrace(currentDiagnosticTrace() ?? newTraceId(), () => {
      diagnose({ event: 'lifecycle.invalidated', caller: 'data_lifecycle', reasonCode: code });
      this.ports.history.invalidate(notice);
      this.ports.media.invalidate();
      this.withdrawDerived(code);
    });
  }

  beginHistoryClear(): () => Promise<void> {
    this.withdraw('history-clear');
    return this.ports.replies.beginHistoryClear();
  }

  historyResyncCompleted(contactId: string): void {
    void this.ports.history.refreshCurrent(contactId);
  }

  async connectionChanging(): Promise<void> {
    this.withdrawDerived('connection_changed');
    await this.ports.media.invalidateAndDrain();
    await this.ports.replies.prepareConnectionChange();
  }

  private withdrawDerived(reasonCode: string): void {
    this.ports.discussion.synchronize(true);
    this.ports.processing.synchronize();
    this.ports.management.synchronize('data_lifecycle', reasonCode);
  }
}
