import type {StorageMigration} from '../contracts.ts';

/**
 * 当前历史目标按联系人取最新一个（current-scope.ts）：此前只能对该联系人的全部历史目标排序，
 * 目标累积到数万时每次范围解析数十毫秒。该索引按 (所有者, 联系人, 类型, 序号倒序) 提供有序入口，
 * 取最新目标与累计目标总数无关。迁移只建索引，不改动、不删除任何行。
 */
export const historyGoalLatestIndexMigration=(version:number):StorageMigration=>({version,sql:`
CREATE INDEX read_goal_contact_kind_order ON read_goal(owner_id,contact_id,kind,creation_no DESC) WHERE creation_no IS NOT NULL;
`});
