import {sha256} from '../../../platform/sha256.ts';
import type {StorageMigration} from '../../../storage/sqlite/contracts.ts';
import {memoryExtractionMigration} from '../schema.ts';
import {discussionMigration} from '../../../reply/sqlite/schema.ts';
import {replyCandidateMigration} from '../../../reply/sqlite/candidates/schema.ts';
import {memoryManagementMigration} from './schema.ts';

export const memoryAdjudicationRebuildPolicy='memory-adjudication-v1' as const;
export type AdjudicationUpgradePhase='prepare'|'create'|'copy'|'drop'|'rename'|'recreate'|'check';
const oldMemorySql=memoryExtractionMigration(8).sql,oldManagementSql=memoryManagementMigration(11).sql;
function table(sql:string,name:string):string{
 const value=sql.match(new RegExp(`CREATE TABLE ${name} \\([\\s\\S]*?\\n\\) STRICT;`))?.[0];
 if(!value)throw new Error('adjudication_published_schema_missing');return value;
}
// 只解析已发布的固定DDL；后续迁移的同名触发器覆盖旧定义，不从现场猜测结构。
const triggers=new Map<string,string>();
for(const sql of [discussionMigration(7).sql,oldMemorySql,replyCandidateMigration(10).sql,memoryManagementMigration(11).sql])
 for(const match of sql.matchAll(/CREATE TRIGGER (\w+)[\s\S]*?\bEND;/g))triggers.set(match[1]!,match[0]);
const affected=[...triggers].filter(([,sql])=>/\b(processing_step|step_input|model_operation|memory_decision|memory_candidate)\b/.test(sql));
const stepTable=table(oldMemorySql,'processing_step').replace('CREATE TABLE processing_step','CREATE TABLE adjudication_next_step').replace("kind='extraction_verification'","kind IN ('extraction_verification','adjudication','relation_verification','merge_verification')").replace('successful_attempt_id TEXT,',"successful_attempt_id TEXT,accepted_memory_revision INTEGER CHECK(accepted_memory_revision IS NULL OR accepted_memory_revision>=0),\n CHECK(kind='extraction_verification' OR accepted_memory_revision IS NOT NULL),");
const operationTable=table(oldMemorySql,'model_operation').replace('CREATE TABLE model_operation','CREATE TABLE adjudication_next_operation').replaceAll("'extraction','verification','discussion'","'extraction','verification','discussion','adjudication','relation_verification','merge_verification'").replace("purpose IN ('extraction','verification')","purpose IN ('extraction','verification','adjudication','relation_verification','merge_verification')");
const decisionTable=table(oldManagementSql,'memory_decision').replace('CREATE TABLE memory_decision','CREATE TABLE adjudication_next_decision')
 .replace("'auto_accept','auto_update'","'auto_accept','auto_update','auto_retire','auto_noop'").replaceAll("('auto_accept','auto_update')","('auto_accept','auto_update','auto_retire','auto_noop')").replace("('auto_update','correct'","('auto_update','auto_retire','auto_noop','correct'");
const candidateTable=table(oldManagementSql,'memory_candidate').replace('CREATE TABLE memory_candidate','CREATE TABLE adjudication_next_candidate').replace("'pending','adopted','rejected','invalidated','deleted'","'pending','adopted','duplicate','rejected','invalidated','deleted'");
const decisionIndexes=[...oldManagementSql.matchAll(/CREATE (?:UNIQUE )?INDEX \w+ ON (?:memory_decision|memory_candidate)\([^;]+;/g)].map(m=>m[0]);
const inputTable=`CREATE TABLE adjudication_next_input (
 owner_id TEXT NOT NULL,step_id TEXT NOT NULL,input_no INTEGER NOT NULL,run_id TEXT,run_input_no INTEGER,
 kind TEXT NOT NULL DEFAULT 'run_message' CHECK(kind IN ('run_message','candidate','memory','message')),
 candidate_id TEXT,accepted_state_revision INTEGER,memory_id TEXT,memory_version_no INTEGER,accepted_head_revision INTEGER,
 source_contact_id TEXT,message_id TEXT,record_id TEXT,accepted_revision INTEGER,
 PRIMARY KEY(owner_id,step_id,input_no),UNIQUE(owner_id,step_id,run_id,run_input_no),
 FOREIGN KEY(owner_id,step_id) REFERENCES processing_step(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,run_id,run_input_no) REFERENCES run_input(owner_id,run_id,input_no),
 FOREIGN KEY(owner_id,candidate_id) REFERENCES memory_candidate(owner_id,id),
 FOREIGN KEY(owner_id,memory_id,memory_version_no) REFERENCES memory_version(owner_id,memory_id,version_no),
 FOREIGN KEY(owner_id,source_contact_id,record_id,message_id) REFERENCES capture_record(owner_id,contact_id,id,message_id),
 CHECK((kind='run_message' AND run_id IS NOT NULL AND run_input_no IS NOT NULL AND candidate_id IS NULL AND accepted_state_revision IS NULL AND memory_id IS NULL AND memory_version_no IS NULL AND accepted_head_revision IS NULL AND source_contact_id IS NULL AND message_id IS NULL AND record_id IS NULL AND accepted_revision IS NULL)
 OR (kind='candidate' AND run_id IS NULL AND run_input_no IS NULL AND candidate_id IS NOT NULL AND accepted_state_revision IS NOT NULL AND accepted_state_revision>=0 AND memory_id IS NULL AND memory_version_no IS NULL AND accepted_head_revision IS NULL AND source_contact_id IS NULL AND message_id IS NULL AND record_id IS NULL AND accepted_revision IS NULL)
 OR (kind='memory' AND run_id IS NULL AND run_input_no IS NULL AND candidate_id IS NULL AND accepted_state_revision IS NULL AND memory_id IS NOT NULL AND memory_version_no IS NOT NULL AND memory_version_no>0 AND accepted_head_revision IS NOT NULL AND accepted_head_revision>=0 AND source_contact_id IS NULL AND message_id IS NULL AND record_id IS NULL AND accepted_revision IS NULL)
 OR (kind='message' AND run_id IS NULL AND run_input_no IS NULL AND candidate_id IS NULL AND accepted_state_revision IS NULL AND memory_id IS NULL AND memory_version_no IS NULL AND accepted_head_revision IS NULL AND source_contact_id IS NOT NULL AND message_id IS NOT NULL AND record_id IS NOT NULL AND accepted_revision IS NOT NULL AND accepted_revision>0))
) STRICT;`;
const typedScope=`CREATE TRIGGER step_input_scope BEFORE INSERT ON step_input WHEN NOT EXISTS (
 SELECT 1 FROM processing_step s JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
 JOIN run_input i ON i.owner_id=NEW.owner_id AND i.run_id=NEW.run_id AND i.input_no=NEW.run_input_no
 WHERE NEW.kind='run_message' AND s.owner_id=NEW.owner_id AND s.id=NEW.step_id AND t.run_id=NEW.run_id AND (t.scope_kind='self' OR t.contact_id=i.source_contact_id)
 UNION ALL SELECT 1 FROM processing_step s JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
 JOIN memory_candidate c ON c.owner_id=t.owner_id AND c.id=NEW.candidate_id
 WHERE NEW.kind='candidate' AND s.owner_id=NEW.owner_id AND s.id=NEW.step_id AND t.scope_kind=c.scope_kind AND t.contact_id IS c.contact_id AND c.state='pending' AND c.state_revision=NEW.accepted_state_revision
 UNION ALL SELECT 1 FROM processing_step s JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
 JOIN memory m ON m.owner_id=t.owner_id AND m.id=NEW.memory_id JOIN memory_version v ON v.owner_id=m.owner_id AND v.memory_id=m.id AND v.version_no=NEW.memory_version_no
 WHERE NEW.kind='memory' AND s.owner_id=NEW.owner_id AND s.id=NEW.step_id AND t.scope_kind=m.scope_kind AND t.contact_id IS m.contact_id
 AND m.current_version_no=v.version_no AND m.head_revision=NEW.accepted_head_revision AND m.state IN ('active','withdrawn') AND v.content_state='present' AND v.provenance_state='eligible'
 UNION ALL SELECT 1 FROM processing_step s JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
 JOIN message m ON m.owner_id=t.owner_id AND m.contact_id=NEW.source_contact_id AND m.id=NEW.message_id
 JOIN capture_record r ON r.owner_id=m.owner_id AND r.contact_id=m.contact_id AND r.message_id=m.id AND r.id=NEW.record_id
 WHERE NEW.kind='message' AND s.owner_id=NEW.owner_id AND s.id=NEW.step_id AND (t.scope_kind='self' OR t.contact_id=m.contact_id)
 AND m.interpretation_revision=NEW.accepted_revision AND m.availability='available' AND r.availability='available' AND r.state='normalized'
 AND EXISTS(SELECT 1 FROM sync_capture sc JOIN read_goal g ON g.owner_id=sc.owner_id AND g.contact_id=sc.contact_id AND g.id=sc.goal_id
 JOIN contact p ON p.owner_id=r.owner_id AND p.id=r.contact_id JOIN owner o ON o.owner_id=p.owner_id
 WHERE sc.owner_id=r.owner_id AND sc.contact_id=r.contact_id AND sc.id=r.capture_id AND m.binding_id=g.binding_id AND p.state='active' AND o.state='active')
 AND EXISTS(WITH RECURSIVE versions(memory_id,version_no) AS (
 SELECT memory_id,memory_version_no FROM step_input WHERE owner_id=NEW.owner_id AND step_id=NEW.step_id AND kind='memory'
 UNION SELECT v.memory_id,v.previous_version_no FROM memory_version v JOIN versions a ON a.memory_id=v.memory_id AND a.version_no=v.version_no WHERE v.owner_id=NEW.owner_id AND v.previous_version_no IS NOT NULL
 UNION SELECT v.memory_id,v.restored_from_version_no FROM memory_version v JOIN versions a ON a.memory_id=v.memory_id AND a.version_no=v.version_no WHERE v.owner_id=NEW.owner_id AND v.restored_from_version_no IS NOT NULL
 UNION SELECT i.memory_id,i.memory_version_no FROM memory_version v JOIN versions a ON a.memory_id=v.memory_id AND a.version_no=v.version_no JOIN memory_decision d ON d.owner_id=v.owner_id AND d.id=v.decision_id JOIN step_attempt sa ON sa.owner_id=d.owner_id AND sa.id=d.execution_id JOIN step_input i ON i.owner_id=sa.owner_id AND i.step_id=sa.step_id AND i.kind='memory' WHERE v.owner_id=NEW.owner_id),
 candidates(candidate_id) AS (
 SELECT candidate_id FROM step_input WHERE owner_id=NEW.owner_id AND step_id=NEW.step_id AND kind='candidate'
 UNION SELECT dc.candidate_id FROM decision_candidate dc JOIN memory_version v ON v.owner_id=dc.owner_id AND v.decision_id=dc.decision_id JOIN versions a ON a.memory_id=v.memory_id AND a.version_no=v.version_no WHERE dc.owner_id=NEW.owner_id),
 sources(source_contact_id,message_id,record_id,accepted_revision) AS (
 SELECT c.source_contact_id,c.message_id,c.record_id,c.accepted_revision FROM memory_citation c WHERE c.owner_id=NEW.owner_id AND (c.candidate_id IN (SELECT candidate_id FROM candidates) OR EXISTS(SELECT 1 FROM versions v WHERE v.memory_id=c.memory_id AND v.version_no=c.version_no))
 UNION SELECT i.source_contact_id,i.message_id,i.record_id,i.accepted_interpretation_revision FROM candidates c JOIN memory_candidate mc ON mc.owner_id=NEW.owner_id AND mc.id=c.candidate_id
 JOIN step_attempt a ON a.owner_id=mc.owner_id AND a.id=mc.produced_attempt_id JOIN processing_step ps ON ps.owner_id=a.owner_id AND ps.id=a.step_id
 JOIN task_contribution tc ON tc.owner_id=ps.owner_id AND tc.task_id=ps.task_id JOIN run_input i ON i.owner_id=tc.owner_id AND i.run_id=tc.run_id AND i.source_contact_id=tc.source_contact_id
 UNION SELECT i.source_contact_id,i.message_id,i.record_id,i.accepted_revision FROM versions a JOIN memory_version v ON v.owner_id=NEW.owner_id AND v.memory_id=a.memory_id AND v.version_no=a.version_no JOIN memory_decision d ON d.owner_id=v.owner_id AND d.id=v.decision_id JOIN step_attempt sa ON sa.owner_id=d.owner_id AND sa.id=d.execution_id JOIN step_input i ON i.owner_id=sa.owner_id AND i.step_id=sa.step_id AND i.kind='message')
 SELECT 1 FROM sources q WHERE q.source_contact_id=NEW.source_contact_id AND q.message_id=NEW.message_id AND q.record_id=NEW.record_id AND q.accepted_revision=NEW.accepted_revision))
 BEGIN SELECT RAISE(ABORT,'step_input_scope'); END;`;
const oldSource=triggers.get('event_source_planned')!;
const typedSource=oldSource.replace(/\)\s*BEGIN SELECT RAISE\(ABORT,'event_source_planned'\); END;$/,` UNION ALL
 SELECT 1 FROM execution_input x JOIN step_input i ON i.owner_id=x.owner_id AND i.step_id=x.planned_step_id AND i.input_no=x.planned_input_no
 WHERE x.owner_id=NEW.owner_id AND x.event_id=NEW.event_id AND i.kind='message' AND i.record_id=NEW.record_id AND i.source_contact_id=NEW.source_contact_id
 UNION ALL SELECT 1 FROM execution_input x JOIN step_input i ON i.owner_id=x.owner_id AND i.step_id=x.planned_step_id AND i.input_no=x.planned_input_no
 JOIN memory_citation c ON c.owner_id=i.owner_id AND ((i.kind='candidate' AND c.candidate_id=i.candidate_id) OR (i.kind='memory' AND c.memory_id=i.memory_id AND c.version_no=i.memory_version_no))
 WHERE x.owner_id=NEW.owner_id AND x.event_id=NEW.event_id AND c.record_id=NEW.record_id AND c.source_contact_id=NEW.source_contact_id)
 BEGIN SELECT RAISE(ABORT,'event_source_planned'); END;`);
const recreated=affected.map(([name,sql])=>name==='step_input_scope'?typedScope:name==='event_source_planned'?typedSource:
 name==='decision_candidate_scope'?sql.replace("('accept','edit_accept','auto_accept','auto_update')","('accept','edit_accept','auto_accept','auto_update','auto_noop')"):
 name==='memory_version_decision'?sql.replace("('reject','withdraw','protect','unprotect')","('reject','withdraw','protect','unprotect','auto_retire','auto_noop')"):
 name==='memory_head_closure'?sql.replace("AND v.content_state='present'","AND d.action NOT IN ('auto_retire','auto_noop') AND v.content_state='present'"):sql).join('\n');
const retireTrigger=`CREATE TRIGGER auto_retire_execution BEFORE INSERT ON memory_decision WHEN NEW.action='auto_retire' AND NEW.outcome='applied' AND NOT EXISTS(
 SELECT 1 FROM step_attempt a JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id
 JOIN model_operation o ON o.owner_id=s.owner_id AND o.memory_step_id=s.id AND o.purpose='adjudication'
 JOIN model_call c ON c.owner_id=o.owner_id AND c.operation_id=o.id AND c.state='succeeded'
 JOIN step_input i ON i.owner_id=s.owner_id AND i.step_id=s.id AND i.kind='memory'
 JOIN memory m ON m.owner_id=i.owner_id AND m.id=i.memory_id
 WHERE a.owner_id=NEW.owner_id AND a.id=NEW.execution_id AND a.state='succeeded' AND s.state='succeeded' AND s.successful_attempt_id=a.id AND s.kind='adjudication'
 AND i.memory_id=NEW.target_memory_id AND i.memory_version_no=NEW.expected_version_no AND i.accepted_head_revision=NEW.expected_head_revision
 AND m.state='active' AND m.manual_protection=0 AND m.current_version_no=i.memory_version_no AND m.head_revision=i.accepted_head_revision
 AND EXISTS(SELECT 1 FROM memory_decision d JOIN memory_version v ON v.owner_id=d.owner_id AND v.decision_id=d.id WHERE d.owner_id=NEW.owner_id AND d.execution_id=NEW.execution_id AND d.actor_kind='system' AND d.action='auto_update' AND d.outcome='applied' AND d.target_memory_id<>NEW.target_memory_id))
 BEGIN SELECT RAISE(ABORT,'auto_retire_execution'); END;`;

// 决定插入前核真实结果及两类实际输入；随后同一SQL语句原子消费，不能留下无候选的applied决定。
const noopTrigger=`CREATE TRIGGER auto_noop_execution BEFORE INSERT ON memory_decision WHEN NEW.action='auto_noop' AND NEW.outcome='applied' AND NOT EXISTS(
 SELECT 1 FROM step_attempt a JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id
 JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
 JOIN model_operation o ON o.owner_id=s.owner_id AND o.memory_step_id=s.id AND o.purpose='adjudication'
 JOIN model_call call ON call.owner_id=o.owner_id AND call.operation_id=o.id AND call.state='succeeded'
 JOIN execution_event e ON e.owner_id=a.owner_id AND e.step_attempt_id=a.id AND e.kind='adjudication_result'
 JOIN execution_input cx ON cx.owner_id=e.owner_id AND cx.event_id=e.id AND cx.role='candidate'
 JOIN step_input ci ON ci.owner_id=cx.owner_id AND ci.step_id=cx.planned_step_id AND ci.input_no=cx.planned_input_no AND ci.step_id=s.id AND ci.kind='candidate'
 JOIN memory_candidate candidate ON candidate.owner_id=ci.owner_id AND candidate.id=ci.candidate_id
 JOIN execution_input mx ON mx.owner_id=e.owner_id AND mx.event_id=e.id AND mx.role='parent_memory'
 JOIN step_input mi ON mi.owner_id=mx.owner_id AND mi.step_id=mx.planned_step_id AND mi.input_no=mx.planned_input_no AND mi.step_id=s.id AND mi.kind='memory'
 JOIN memory m ON m.owner_id=mi.owner_id AND m.id=mi.memory_id
 JOIN memory_version v ON v.owner_id=m.owner_id AND v.memory_id=m.id AND v.version_no=m.current_version_no
 WHERE a.owner_id=NEW.owner_id AND a.id=NEW.execution_id AND a.state='succeeded' AND s.state='succeeded' AND s.successful_attempt_id=a.id AND s.kind='adjudication'
 AND candidate.state='pending' AND candidate.state_revision=ci.accepted_state_revision AND t.scope_kind=candidate.scope_kind AND t.contact_id IS candidate.contact_id
 AND m.scope_kind=candidate.scope_kind AND m.contact_id IS candidate.contact_id
 AND mi.memory_id=NEW.target_memory_id AND mi.memory_version_no=NEW.expected_version_no AND mi.accepted_head_revision=NEW.expected_head_revision
 AND m.state IN ('active','withdrawn') AND m.current_version_no=mi.memory_version_no AND m.head_revision=mi.accepted_head_revision AND v.content_state='present' AND v.provenance_state='eligible'
 AND json_extract(e.payload,'$.action')='auto_noop' AND json_type(e.payload,'$.reason')='null'
 AND json_extract(e.payload,'$.candidateId')=ci.candidate_id AND json_type(e.payload,'$.parentMemoryIds')='array'
 AND json_array_length(e.payload,'$.parentMemoryIds')=1 AND json_extract(e.payload,'$.parentMemoryIds[0]')=NEW.target_memory_id
 AND (SELECT count(*) FROM execution_event result WHERE result.owner_id=a.owner_id AND result.step_attempt_id=a.id AND result.kind='adjudication_result')=1)
 BEGIN SELECT RAISE(ABORT,'auto_noop_execution'); END;
CREATE TRIGGER auto_noop_consume AFTER INSERT ON memory_decision WHEN NEW.action='auto_noop' AND NEW.outcome='applied' BEGIN
 INSERT INTO decision_candidate(owner_id,decision_id,candidate_id,relation_kind,accepted_state_revision)
 SELECT DISTINCT NEW.owner_id,NEW.id,i.candidate_id,'accepted',i.accepted_state_revision FROM execution_event e
 JOIN execution_input x ON x.owner_id=e.owner_id AND x.event_id=e.id AND x.role='candidate'
 JOIN step_input i ON i.owner_id=x.owner_id AND i.step_id=x.planned_step_id AND i.input_no=x.planned_input_no AND i.kind='candidate'
 WHERE e.owner_id=NEW.owner_id AND e.step_attempt_id=NEW.execution_id AND e.kind='adjudication_result' AND json_extract(e.payload,'$.candidateId')=i.candidate_id;
 SELECT RAISE(ABORT,'auto_noop_consumption') WHERE changes()<>1;
 UPDATE memory_candidate SET state='duplicate',state_revision=state_revision+1 WHERE owner_id=NEW.owner_id AND state='pending' AND id IN (SELECT candidate_id FROM decision_candidate WHERE owner_id=NEW.owner_id AND decision_id=NEW.id);
 SELECT RAISE(ABORT,'auto_noop_consumption') WHERE changes()<>1;
 END;
CREATE TRIGGER noop_candidate_scope BEFORE INSERT ON decision_candidate WHEN EXISTS(SELECT 1 FROM memory_decision d WHERE d.owner_id=NEW.owner_id AND d.id=NEW.decision_id AND d.action='auto_noop') AND NOT EXISTS(
 SELECT 1 FROM memory_decision d JOIN execution_event e ON e.owner_id=d.owner_id AND e.step_attempt_id=d.execution_id AND e.kind='adjudication_result'
 JOIN execution_input x ON x.owner_id=e.owner_id AND x.event_id=e.id AND x.role='candidate'
 JOIN step_input i ON i.owner_id=x.owner_id AND i.step_id=x.planned_step_id AND i.input_no=x.planned_input_no AND i.kind='candidate'
 WHERE d.owner_id=NEW.owner_id AND d.id=NEW.decision_id AND d.outcome='applied' AND NEW.relation_kind='accepted'
 AND i.candidate_id=NEW.candidate_id AND i.accepted_state_revision=NEW.accepted_state_revision AND json_extract(e.payload,'$.candidateId')=NEW.candidate_id AND json_extract(e.payload,'$.action')='auto_noop')
 BEGIN SELECT RAISE(ABORT,'noop_candidate_scope'); END;
CREATE TRIGGER noop_candidate_fixed BEFORE UPDATE ON decision_candidate WHEN EXISTS(SELECT 1 FROM memory_decision d WHERE d.owner_id=OLD.owner_id AND d.id=OLD.decision_id AND d.action='auto_noop')
 BEGIN SELECT RAISE(ABORT,'noop_candidate_immutable'); END;
CREATE TRIGGER noop_candidate_removed AFTER DELETE ON decision_candidate WHEN EXISTS(SELECT 1 FROM memory_decision d WHERE d.owner_id=OLD.owner_id AND d.id=OLD.decision_id AND d.action='auto_noop' AND d.outcome='applied')
 BEGIN UPDATE memory_decision SET outcome='redacted',execution_id=NULL,request_seal=NULL WHERE owner_id=OLD.owner_id AND id=OLD.decision_id; END;
CREATE TRIGGER duplicate_candidate_insert BEFORE INSERT ON memory_candidate WHEN NEW.state='duplicate' BEGIN SELECT RAISE(ABORT,'duplicate_requires_noop'); END;
CREATE TRIGGER duplicate_candidate_transition BEFORE UPDATE OF state ON memory_candidate WHEN NEW.state='duplicate' AND NOT(
 OLD.state='pending' AND NEW.state_revision=OLD.state_revision+1 AND NEW.owner_id=OLD.owner_id AND NEW.id=OLD.id AND EXISTS(
 SELECT 1 FROM decision_candidate c JOIN memory_decision d ON d.owner_id=c.owner_id AND d.id=c.decision_id WHERE c.owner_id=OLD.owner_id AND c.candidate_id=OLD.id AND c.accepted_state_revision=OLD.state_revision AND c.relation_kind='accepted' AND d.action='auto_noop' AND d.outcome='applied'))
 BEGIN SELECT RAISE(ABORT,'duplicate_requires_noop'); END;
CREATE TRIGGER duplicate_candidate_terminal BEFORE UPDATE OF state ON memory_candidate WHEN OLD.state='duplicate' AND NEW.state NOT IN ('duplicate','invalidated','deleted') BEGIN SELECT RAISE(ABORT,'duplicate_candidate_terminal'); END;`;
export const memoryAdjudicationUpgradeSteps:readonly {phase:AdjudicationUpgradePhase;sql:string}[]=Object.freeze([
 {phase:'prepare',sql:affected.map(([name])=>`DROP TRIGGER ${name};`).join('\n')},
 {phase:'create',sql:[stepTable,operationTable,inputTable,decisionTable,candidateTable].join('\n')},
 {phase:'copy',sql:`INSERT INTO adjudication_next_step(owner_id,id,task_id,step_no,kind,state,input_state,successful_attempt_id) SELECT owner_id,id,task_id,step_no,kind,state,input_state,successful_attempt_id FROM processing_step;
INSERT INTO adjudication_next_operation(owner_id,id,purpose,memory_step_id,slot,input_seal,state,commit_forbidden_at,reply_request_id) SELECT owner_id,id,purpose,memory_step_id,slot,input_seal,state,commit_forbidden_at,reply_request_id FROM model_operation;
INSERT INTO adjudication_next_input(owner_id,step_id,input_no,run_id,run_input_no) SELECT owner_id,step_id,input_no,run_id,run_input_no FROM step_input;
INSERT INTO adjudication_next_decision(owner_id,id,request_key,request_seal,action,actor_kind,execution_id,target_memory_id,expected_version_no,expected_head_revision,restored_from_version_no,created_at,outcome) SELECT owner_id,id,request_key,request_seal,action,actor_kind,execution_id,target_memory_id,expected_version_no,expected_head_revision,restored_from_version_no,created_at,outcome FROM memory_decision;
INSERT INTO adjudication_next_candidate(owner_id,id,scope_kind,contact_id,proposed_body,produced_attempt_id,event_id,output_no,state,state_revision) SELECT owner_id,id,scope_kind,contact_id,proposed_body,produced_attempt_id,event_id,output_no,state,state_revision FROM memory_candidate;`},
 {phase:'drop',sql:'DROP TABLE step_input; DROP TABLE model_operation; DROP TABLE processing_step; DROP TABLE memory_decision; DROP TABLE memory_candidate;'},
 {phase:'rename',sql:'ALTER TABLE adjudication_next_step RENAME TO processing_step; ALTER TABLE adjudication_next_operation RENAME TO model_operation; ALTER TABLE adjudication_next_input RENAME TO step_input; ALTER TABLE adjudication_next_decision RENAME TO memory_decision; ALTER TABLE adjudication_next_candidate RENAME TO memory_candidate;'},
 {phase:'recreate',sql:`${recreated}
${decisionIndexes.join('\n')}
${retireTrigger}
${noopTrigger}
CREATE TRIGGER adjudication_operation_step BEFORE INSERT ON model_operation WHEN NEW.purpose IN ('adjudication','relation_verification','merge_verification') AND NOT EXISTS(SELECT 1 FROM processing_step s WHERE s.owner_id=NEW.owner_id AND s.id=NEW.memory_step_id AND s.kind=NEW.purpose) BEGIN SELECT RAISE(ABORT,'adjudication_operation_step'); END;
CREATE TRIGGER step_memory_revision_immutable BEFORE UPDATE OF accepted_memory_revision ON processing_step BEGIN SELECT RAISE(ABORT,'step_memory_revision_immutable'); END;
CREATE INDEX step_inputs_candidate ON step_input(owner_id,candidate_id) WHERE candidate_id IS NOT NULL;
CREATE INDEX step_inputs_memory ON step_input(owner_id,memory_id,memory_version_no) WHERE memory_id IS NOT NULL;
CREATE INDEX step_inputs_source ON step_input(owner_id,source_contact_id,record_id) WHERE record_id IS NOT NULL;
CREATE INDEX run_contacts_source ON run_contact(owner_id,contact_id,run_id);
CREATE INDEX operation_scopes_source ON operation_scope(owner_id,source_contact_id,operation_id);`},
 {phase:'check',sql:'SELECT 1;'},
].map(step=>Object.freeze(step))) as readonly {phase:AdjudicationUpgradePhase;sql:string}[];
const sql=memoryAdjudicationUpgradeSteps.map(step=>step.sql).join('\n');
export const memoryAdjudicationRebuildChecksum=sha256(sql);
/** 版本12的受信任固定重建；Worker再核SQL与checksum，不能由RPC关闭FK。 */
export const memoryAdjudicationMigration=(version:number):StorageMigration=>({version,sql,rebuild:memoryAdjudicationRebuildPolicy});
