import type {StorageMigration} from '../contracts.ts';

/** 认证操作保存无正文证据；绑定身份即来源认证代次，旧业务资料不迁移。 */
export const historyRecertifyMigration=(version:number):StorageMigration=>({version,sql:`
CREATE TABLE history_source_recertification (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,contact_id TEXT NOT NULL,request_key TEXT NOT NULL,runtime_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('running','completed','failed','interrupted')),
 stage TEXT NOT NULL CHECK(stage IN ('metadata','history','activation','completed')),
 failure_code TEXT,started_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,finished_at INTEGER,
 old_binding_id TEXT NOT NULL,new_binding_id TEXT,new_grant_id TEXT,old_token_json TEXT NOT NULL,
 token_json TEXT,target_json TEXT,support_json TEXT,guard_id TEXT,guard_state TEXT NOT NULL DEFAULT 'none' CHECK(guard_state IN ('none','active','lost')),
 goal_id TEXT,preserved_message_count INTEGER NOT NULL,old_fence_json TEXT NOT NULL,old_scope_json TEXT,old_lease_json TEXT,
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,request_key),FOREIGN KEY(owner_id,contact_id) REFERENCES contact(owner_id,id)
) STRICT;
CREATE UNIQUE INDEX history_recertification_running ON history_source_recertification(owner_id,contact_id) WHERE state='running';
CREATE INDEX history_recertification_contact ON history_source_recertification(owner_id,contact_id,started_at);
`});

/** 取消意图不含正文；先取消后接纳也不能重放该请求。 */
export const historyRecertifyCancelMigration=(version:number):StorageMigration=>({version,sql:`
CREATE TABLE history_source_recertification_cancel (
 owner_id TEXT NOT NULL,contact_id TEXT NOT NULL,request_key TEXT NOT NULL,cancelled_at INTEGER NOT NULL,
 PRIMARY KEY(owner_id,request_key),FOREIGN KEY(owner_id,contact_id) REFERENCES contact(owner_id,id)
) STRICT;
CREATE INDEX history_recertification_cancel_contact ON history_source_recertification_cancel(owner_id,contact_id);
`});
