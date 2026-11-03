import type { ContactHistoryController } from './contact-history/controller';
import type { MessageMediaController } from './media/controller';
import type { TraceController } from './traces/controller';
import type { CandidateProvenanceController } from './candidate-provenance/controller';
import type { SkillLearningController } from './skill-learning/controller';
import type { ExpressionPreferenceController } from './expression-preferences/controller';
import type { MemoryReadingController } from './memory/controller';
import type { FixedMemoryProcessingController } from './memory/fixed-processing';
import type { SqliteMemoryManagementController } from './memory/sqlite-management';
import type { SqliteDiscussionController } from './reply/sqlite-discussion-bridge';
import type { ReplySession } from './reply/session';

const notices = {
 'source-deletion': '聊天记录来源正在删除，删除完成后会重新读取。',
 'contact-deletion': '联系人正在删除，旧聊天与资料已停用。',
 'history-clear': '聊天记录正在清空，完成后可重新同步并刷新。',
 recertification: '来源正在重新认证，旧聊天资料已撤下；全部核验完成后会刷新。',
};
interface Dependencies {
 history: Pick<ContactHistoryController, 'getState' | 'invalidate' | 'refreshCurrent'>;
 media: Pick<MessageMediaController, 'invalidate' | 'invalidateAndDrain'>;
 traces: Pick<TraceController, 'invalidateSource'>;
 provenance: Pick<CandidateProvenanceController, 'invalidateSource'>;
 skills: Pick<SkillLearningController, 'invalidate'>;
 preferences: Pick<ExpressionPreferenceController, 'invalidateSource'>;
 memory: Pick<MemoryReadingController, 'revalidateDeletedSource'>;
 processing: Pick<FixedMemoryProcessingController, 'synchronize'>;
 management: Pick<SqliteMemoryManagementController, 'synchronize'>;
 discussion: Pick<SqliteDiscussionController, 'synchronize'>;
 replies: Pick<ReplySession, 'revalidateDeletedSource' | 'prepareGenerationConnectionChange' | 'beginHistoryClear'>;
}

/** 来源变化的撤下清单集中在这里；各控制器继续拥有自己的取消、代次和晚到结果守卫。 */
export class DesktopDataLifecycle {
 constructor(private readonly ports: Dependencies) {}

 withdraw(reason: keyof typeof notices): void {
  const p = this.ports;
  p.history.invalidate(notices[reason]);
  p.media.invalidate();
  this.withdrawDerived();
 }

 private withdrawDerived(): void {
  const p = this.ports;
  p.traces.invalidateSource();
  p.provenance.invalidateSource();
  p.skills.invalidate();
  this.withdrawSqlite();
 }

 private withdrawSqlite(): void {
  this.ports.discussion.synchronize(true);
  this.ports.processing.synchronize();
  this.ports.management.synchronize();
 }

 beginHistoryClear(contactId: string): () => Promise<void> {
  this.withdraw('history-clear');
  return this.ports.replies.beginHistoryClear(contactId);
 }

 async sourceChanged(contactId: string): Promise<void> {
  const p = this.ports;
  // 原删除在切换联系人后仍会回调；本人衍生资料需复验，另一联系人的聊天和媒体仍有效。
  if (p.history.getState().contactId === contactId) {
   p.history.invalidate(notices['source-deletion']);
   p.media.invalidate();
  }
  this.withdrawDerived();
  await Promise.all([p.replies.revalidateDeletedSource(contactId), p.memory.revalidateDeletedSource(contactId), p.preferences.invalidateSource(contactId)]);
  await p.history.refreshCurrent(contactId);
 }

 async connectionChanging(): Promise<void> {
  this.withdrawSqlite();
  await this.ports.media.invalidateAndDrain();
  await this.ports.replies.prepareGenerationConnectionChange();
 }
}
