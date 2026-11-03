import type {StorageMigration} from '../../../storage/sqlite/contracts.ts';

// 来源时间由具名动作复用事实来源投影重建；触发器只标记身份，不能复制另一套事实规则。
const childTriggers=['INSERT','UPDATE','DELETE'].flatMap(operation=>{
 const rows=operation==='UPDATE'?['OLD','NEW']:[operation==='DELETE'?'OLD':'NEW'];
 return ['memory_version','memory_citation'].map(table=>`DROP TRIGGER ${table}_timeline_${operation.toLowerCase()};
 CREATE TRIGGER ${table}_timeline_${operation.toLowerCase()} AFTER ${operation} ON ${table} BEGIN
  ${rows.map(row=>`UPDATE memory SET management_timeline_dirty=1 WHERE owner_id=${row}.owner_id AND id=${row}.memory_id AND current_version_no=${row}.version_no
   ${operation==='UPDATE'&&row==='OLD'?'AND (OLD.owner_id<>NEW.owner_id OR OLD.memory_id IS NOT NEW.memory_id OR OLD.version_no IS NOT NEW.version_no)':''};`).join('\n')}
 END;`);
}).join('\n');
export const memoryManagementTimelineProjectionMigration=(version:number):StorageMigration=>({version,sql:`
ALTER TABLE memory ADD COLUMN management_timeline_dirty INTEGER NOT NULL DEFAULT 1 CHECK(management_timeline_dirty IN (0,1));
CREATE INDEX memory_management_timeline_dirty ON memory(owner_id,scope_kind,contact_id,management_timeline_dirty,id);
DROP TRIGGER memory_timeline_insert;
DROP TRIGGER memory_timeline_update;
CREATE TRIGGER memory_timeline_update AFTER UPDATE OF current_version_no,state ON memory BEGIN
 UPDATE memory SET management_timeline_dirty=1 WHERE owner_id=NEW.owner_id AND id=NEW.id;
END;
${childTriggers}
DROP TRIGGER message_timeline_time;
CREATE TRIGGER message_timeline_time AFTER UPDATE OF sent_at ON message BEGIN
 UPDATE memory SET management_timeline_dirty=1 WHERE owner_id=NEW.owner_id AND id IN(
  SELECT citation.memory_id FROM memory_citation citation JOIN memory current ON current.owner_id=citation.owner_id AND current.id=citation.memory_id AND current.current_version_no=citation.version_no
  WHERE citation.owner_id=NEW.owner_id AND citation.source_contact_id=NEW.contact_id AND citation.message_id=NEW.id AND citation.memory_id IS NOT NULL
 );
END;
`});
