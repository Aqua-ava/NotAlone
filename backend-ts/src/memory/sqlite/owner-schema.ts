import type {StorageMigration} from '../../storage/sqlite/contracts.ts';
/** 本人阶段保留真实上游贡献，不让联系人执行冒充本人producer。 */
export const memoryOwnerContributionMigration=(version:number):StorageMigration=>({version,sql:`
CREATE TABLE self_contribution (
 owner_id TEXT NOT NULL,event_id TEXT NOT NULL,producer_event_id TEXT NOT NULL,
 PRIMARY KEY(owner_id,event_id),UNIQUE(owner_id,producer_event_id),
 FOREIGN KEY(owner_id,event_id) REFERENCES execution_event(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,producer_event_id) REFERENCES execution_event(owner_id,id) ON DELETE CASCADE,
 CHECK(event_id<>producer_event_id)
) STRICT;
CREATE TRIGGER self_contribution_producer BEFORE INSERT ON self_contribution WHEN NOT EXISTS (
 SELECT 1 FROM execution_event result
 JOIN step_attempt ra ON ra.owner_id=result.owner_id AND ra.id=result.step_attempt_id
 JOIN processing_step rs ON rs.owner_id=ra.owner_id AND rs.id=ra.step_id
 JOIN processing_task rt ON rt.owner_id=rs.owner_id AND rt.id=rs.task_id
 JOIN execution_event source ON source.owner_id=result.owner_id AND source.id=NEW.producer_event_id
 JOIN step_attempt sa ON sa.owner_id=source.owner_id AND sa.id=source.step_attempt_id
 JOIN processing_step ss ON ss.owner_id=sa.owner_id AND ss.id=sa.step_id
 JOIN processing_task st ON st.owner_id=ss.owner_id AND st.id=ss.task_id
 JOIN task_contribution tc ON tc.owner_id=rt.owner_id AND tc.task_id=rt.id AND tc.run_id=rt.run_id AND tc.source_contact_id=st.contact_id
 WHERE result.owner_id=NEW.owner_id AND result.id=NEW.event_id AND rt.scope_kind='self' AND rt.contact_id IS NULL
 AND st.scope_kind='contact' AND st.contact_id IS NOT NULL AND st.run_id=rt.run_id AND st.state='succeeded'
 AND result.kind='verified_output' AND source.kind='verified_self_contribution' AND result.payload=source.payload
 AND sa.state='succeeded' AND ss.state='succeeded' AND ss.successful_attempt_id=sa.id
 AND json_extract(source.payload,'$.fact.subject')='self' AND json_extract(source.payload,'$.scopeKind')='self'
 AND json_extract(source.payload,'$.contactId') IS NULL)
 BEGIN SELECT RAISE(ABORT,'self_contribution_producer'); END;
CREATE TRIGGER self_contribution_immutable BEFORE UPDATE ON self_contribution
 BEGIN SELECT RAISE(ABORT,'self_contribution_immutable'); END;
`});
