import type {StorageMigration} from '../../../storage/sqlite/contracts.ts';
import {managementTimelineSourceTime as sourceTime} from './timeline-schema.ts';

// 已应用的35不可改写；新版触发器只重算实际当前版，删除屏障内由最终头状态一次清空投影。
const childTriggers=['INSERT','UPDATE','DELETE'].flatMap(operation=>{
 const rows=operation==='UPDATE'?['OLD','NEW']:[operation==='DELETE'?'OLD':'NEW'];
 return ['memory_version','memory_citation'].map(table=>`DROP TRIGGER ${table}_timeline_${operation.toLowerCase()};
 CREATE TRIGGER ${table}_timeline_${operation.toLowerCase()} AFTER ${operation} ON ${table} BEGIN
  ${rows.map(row=>`UPDATE memory SET management_source_time=${sourceTime} WHERE owner_id=${row}.owner_id AND id=${row}.memory_id AND current_version_no=${row}.version_no
   AND NOT EXISTS(SELECT 1 FROM deletion_operation WHERE owner_identity=${row}.owner_id AND state<>'completed')
   ${operation==='UPDATE'&&row==='OLD'?'AND (OLD.owner_id<>NEW.owner_id OR OLD.memory_id IS NOT NEW.memory_id OR OLD.version_no IS NOT NEW.version_no)':''};`).join('\n')}
 END;`);
}).join('\n');
export const memoryManagementTimelineMaintenanceMigration=(version:number):StorageMigration=>({version,sql:`
${childTriggers}
DROP TRIGGER message_timeline_time;
CREATE TRIGGER message_timeline_time AFTER UPDATE OF sent_at ON message BEGIN
 UPDATE memory SET management_source_time=${sourceTime} WHERE owner_id=NEW.owner_id AND id IN(
  SELECT citation.memory_id FROM memory_citation citation JOIN memory current ON current.owner_id=citation.owner_id AND current.id=citation.memory_id AND current.current_version_no=citation.version_no
  WHERE citation.owner_id=NEW.owner_id AND citation.source_contact_id=NEW.contact_id AND citation.message_id=NEW.id AND citation.memory_id IS NOT NULL
 );
END;
`});
