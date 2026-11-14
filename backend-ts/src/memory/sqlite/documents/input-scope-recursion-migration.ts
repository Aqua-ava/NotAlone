import type {StorageMigration} from '../../../storage/sqlite/contracts.ts';
import {memoryDocumentsUpgradeSteps} from './schema.ts';

// 从已冻结的完整定义生成增量迁移，保留候选、来源及文档输入的全部资格分支。
const canonical=memoryDocumentsUpgradeSteps.flatMap(step=>[...step.sql.matchAll(/CREATE TRIGGER step_input_scope\b[\s\S]*?\bEND;/g)].map(match=>match[0]));
if(canonical.length!==1)throw new Error('来源输入触发器的冻结定义不唯一');
function replaceExactly(sql:string,before:string,after:string,count:number):string {
 if(sql.split(before).length!==count+1)throw new Error('来源输入递归分支与冻结定义不匹配');
 return sql.replaceAll(before,after);
}
const priorVersion='FROM memory_version v JOIN versions a ON a.memory_id=v.memory_id AND a.version_no=v.version_no WHERE v.owner_id=NEW.owner_id';
const parentVersion="FROM memory_version v JOIN versions a ON a.memory_id=v.memory_id AND a.version_no=v.version_no JOIN memory_decision d ON d.owner_id=v.owner_id AND d.id=v.decision_id JOIN step_attempt sa ON sa.owner_id=d.owner_id AND sa.id=d.execution_id JOIN step_input i ON i.owner_id=sa.owner_id AND i.step_id=sa.step_id AND i.kind='memory'";
let optimized=replaceExactly(canonical[0]!,priorVersion,
 'FROM versions a CROSS JOIN memory_version v ON v.memory_id=a.memory_id AND v.version_no=a.version_no WHERE v.owner_id=NEW.owner_id',2);
optimized=replaceExactly(optimized,parentVersion,
 "FROM versions a CROSS JOIN memory_version v ON v.memory_id=a.memory_id AND v.version_no=a.version_no CROSS JOIN memory_decision d ON d.owner_id=v.owner_id AND d.id=v.decision_id CROSS JOIN step_attempt sa ON sa.owner_id=d.owner_id AND sa.id=d.execution_id CROSS JOIN step_input i ON i.owner_id=sa.owner_id AND i.step_id=sa.step_id AND i.kind='memory'",1);

/** 仅固定三条版本递归臂的连接顺序，按版本主键查找；来源集合、去重及全部判定条件不变。 */
export const memoryDocumentInputScopeRecursionMigration=(version:number):StorageMigration=>({version,sql:`
DROP TRIGGER step_input_scope;
${optimized}
`});
