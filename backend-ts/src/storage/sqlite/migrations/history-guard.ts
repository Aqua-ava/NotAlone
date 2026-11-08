import type {StorageMigration} from '../contracts.ts';

/** 标记曾经需要活守卫；运行代次变化不能被当作连续证明。 */
export const historyGuardMigration=(version:number):StorageMigration=>({version,sql:`
CREATE TABLE history_guard_lease (
 owner_id TEXT NOT NULL,contact_id TEXT NOT NULL,binding_id TEXT NOT NULL,conversation_id TEXT NOT NULL,
 source_generation TEXT NOT NULL,guard_id TEXT NOT NULL,runtime_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','lost')),
 PRIMARY KEY(owner_id,contact_id),FOREIGN KEY(owner_id,contact_id) REFERENCES contact(owner_id,id)
) STRICT;
`});
