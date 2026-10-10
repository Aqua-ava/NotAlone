/**
 * 主进程已核实的助手会话删除回执，只含身份，不携带讨论或候选正文。
 * 生产者只有在同联系人、范围版本、连接代次及确切会话 GET 404 后发布；
 * 消费者只处理新的 revision，并复核当前范围和连接，不把旧回执当新删除。
 * 回执只通知暂存编辑与来历清理，不替代后端来源或候选版本权威。
 */
export interface ConfirmedAssistantSessionDeletion {
  readonly sessionId: string;
  readonly contactId: string;
  readonly scopeRevision: number;
  readonly connectionGeneration: number;
  readonly revision: number;
}
