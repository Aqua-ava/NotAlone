import type {StorageMigration} from '../contracts.ts';

/** 记忆核验凭据按实际模型调用定位，避免扫描同一用户的全部执行事件。 */
export const executionEventCallIndexMigration=(version:number):StorageMigration=>({version,sql:`
CREATE INDEX execution_event_call_kind ON execution_event(owner_id,originated_call_id,kind);
`});
