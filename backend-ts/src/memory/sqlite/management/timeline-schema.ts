import type {StorageMigration} from '../../../storage/sqlite/contracts.ts';

// 与 memoriesBySourceTime 一致：当前版直接来源的最晚已知聊天时间；未知置后，不借用决定或旧版时间。
const sourceTime=`CASE WHEN state='active' THEN (
 SELECT max(message.sent_at) FROM memory_version version
 JOIN memory_citation citation ON citation.owner_id=version.owner_id AND citation.memory_id=version.memory_id AND citation.version_no=version.version_no
 JOIN message ON message.owner_id=citation.owner_id AND message.contact_id=citation.source_contact_id AND message.id=citation.message_id
 WHERE version.owner_id=memory.owner_id AND version.memory_id=memory.id AND version.version_no=memory.current_version_no
 AND version.content_state='present' AND version.provenance_state='eligible'
 AND message.sent_at>=0 AND message.sent_at<=253402300799999
) ELSE NULL END`;
const refresh=(owner:string,memory:string)=>`UPDATE memory SET management_source_time=${sourceTime} WHERE owner_id=${owner} AND id=${memory};`;
const childTriggers=['INSERT','UPDATE','DELETE'].flatMap(operation=>{
 const rows=operation==='UPDATE'?['OLD','NEW']:[operation==='DELETE'?'OLD':'NEW'];
 return ['memory_version','memory_citation'].map(table=>`CREATE TRIGGER ${table}_timeline_${operation.toLowerCase()} AFTER ${operation} ON ${table} BEGIN
  ${rows.map(row=>refresh(`${row}.owner_id`,`${row}.memory_id`)).join('\n')}
 END;`);
}).join('\n');
export const memoryManagementTimelineMigration=(version:number):StorageMigration=>({version,sql:`
ALTER TABLE memory ADD COLUMN management_source_time INTEGER;
UPDATE memory SET management_source_time=${sourceTime};
CREATE INDEX memory_management_timeline ON memory(owner_id,scope_kind,contact_id,(-coalesce(management_source_time,-1)),id);
CREATE INDEX memory_citation_message_timeline ON memory_citation(owner_id,source_contact_id,message_id,memory_id);
CREATE TRIGGER memory_timeline_insert AFTER INSERT ON memory BEGIN ${refresh('NEW.owner_id','NEW.id')} END;
CREATE TRIGGER memory_timeline_update AFTER UPDATE OF current_version_no,state ON memory BEGIN ${refresh('NEW.owner_id','NEW.id')} END;
${childTriggers}
CREATE TRIGGER message_timeline_time AFTER UPDATE OF sent_at ON message BEGIN
 UPDATE memory SET management_source_time=${sourceTime} WHERE owner_id=NEW.owner_id AND id IN(
  SELECT memory_id FROM memory_citation WHERE owner_id=NEW.owner_id AND source_contact_id=NEW.contact_id AND message_id=NEW.id AND memory_id IS NOT NULL
 );
END;
`});

export const managementTimelineSourceTime=sourceTime;
