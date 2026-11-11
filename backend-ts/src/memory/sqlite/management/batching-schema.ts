import type {StorageMigration} from '../../../storage/sqlite/contracts.ts';

/** 这20项只维护分页修订或时间线标记；消费与文档身份仍保持原子业务触发器。 */
export const managementDerivedTriggerNames=[
 ...['memory','memory_candidate','memory_version','memory_decision'].flatMap(table=>['insert','update','delete'].map(operation=>`${table}_management_${operation}`)),
 'memory_timeline_update',
 ...['memory_version','memory_citation'].flatMap(table=>['insert','update','delete'].map(operation=>`${table}_timeline_${operation}`)),
 'message_timeline_time',
];
export const memoryManagementBatchingMigration=(version:number):StorageMigration=>({version,sql:`
-- 受控写入连接在迁移完成后安装同名TEMP触发器；主库只保存已结清的派生状态。
${managementDerivedTriggerNames.map(name=>`DROP TRIGGER ${name};`).join('\n')}
`});
