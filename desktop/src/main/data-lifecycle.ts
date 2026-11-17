import type { ContactHistoryController } from './contact-history/controller';
import type { MessageMediaController } from './media/controller';
import type { TraceController } from './traces/controller';
import type { FixedMemoryProcessingController } from './memory/fixed-processing';
import type { SqliteMemoryManagementController } from './memory/sqlite-management';
import type { SqliteDiscussionController } from './reply/sqlite-discussion-bridge';
import type { ReplySession } from './reply/session';
import {currentDiagnosticTrace,diagnose,newTraceId,withDiagnosticTrace} from '../../../backend-ts/src/diagnostics/context';

const notices = {
 'source-deletion': '聊天记录来源正在删除，删除完成后会重新读取。',
 'contact-deletion': '联系人正在删除，旧聊天与资料已停用。',
 'history-clear': '聊天记录正在清空，完成后可重新同步并刷新。',
};
interface Dependencies {
 history: Pick<ContactHistoryController, 'getState' | 'invalidate' | 'refreshCurrent'>;
 media: Pick<MessageMediaController, 'invalidate' | 'invalidateAndDrain'>;
 traces: Pick<TraceController, 'invalidateSource'>;
 processing: Pick<FixedMemoryProcessingController, 'synchronize'>;
 management: Pick<SqliteMemoryManagementController, 'synchronize'>;
 discussion: Pick<SqliteDiscussionController, 'synchronize'>;
 replies: Pick<ReplySession, 'revalidateDeletedSource' | 'prepareConnectionChange' | 'beginHistoryClear'>;
}

/** 来源变化的撤下清单集中在这里；各控制器继续拥有自己的取消、代次和晚到结果守卫。 */
export class DesktopDataLifecycle {
 constructor(private readonly ports: Dependencies) {}

 withdraw(reason: keyof typeof notices): void {
  withDiagnosticTrace(currentDiagnosticTrace()??newTraceId(),()=>{
  const p = this.ports;
  const reasonCode=reason==='contact-deletion'?'contact_deleted':reason==='history-clear'?'history_cleared':'source_deleted';
  diagnose({event:'lifecycle.invalidated',caller:'data_lifecycle',reasonCode});
  p.history.invalidate(notices[reason]);
  p.media.invalidate();
  this.withdrawDerived(reasonCode);
  });
 }

 private withdrawDerived(reasonCode:string): void {
  const p = this.ports;
  p.traces.invalidateSource();
  this.withdrawSqlite(reasonCode);
 }

 private withdrawSqlite(reasonCode:string): void {
  this.ports.discussion.synchronize(true);
  this.ports.processing.synchronize();
  this.ports.management.synchronize('data_lifecycle',reasonCode);
 }

 beginHistoryClear(contactId: string): () => Promise<void> {
  this.withdraw('history-clear');
  return this.ports.replies.beginHistoryClear(contactId);
 }

 async sourceChanged(contactId: string): Promise<void> {
  return withDiagnosticTrace(currentDiagnosticTrace()??newTraceId(),async()=>{
  const p = this.ports;
  diagnose({event:'lifecycle.invalidated',caller:'data_lifecycle',reasonCode:'source_changed',contactPrefix:contactId.slice(0,8)});
  // 原删除在切换联系人后仍会回调；本人衍生资料需复验，另一联系人的聊天和媒体仍有效。
  if (p.history.getState().contactId === contactId) {
   p.history.invalidate(notices['source-deletion']);
   p.media.invalidate();
  }
  this.withdrawDerived('source_changed');
  await p.replies.revalidateDeletedSource(contactId);
  await p.history.refreshCurrent(contactId);
  });
 }

 async connectionChanging(): Promise<void> {
  this.withdrawSqlite('connection_changed');
  await this.ports.media.invalidateAndDrain();
  await this.ports.replies.prepareConnectionChange();
 }
}
