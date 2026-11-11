import type {DatabaseSync} from 'node:sqlite';

const upsert='ON CONFLICT(owner_id,scope_kind,contact_key) DO UPDATE SET delta=delta+excluded.delta;';
const direct=(row:string)=>`INSERT INTO notalone_management_scope_delta
 SELECT ${row}.owner_id,${row}.scope_kind,COALESCE(${row}.contact_id,''),1 WHERE 1 ${upsert}`;
const dependent=(row:string,column:string)=>`INSERT INTO notalone_management_scope_delta
 SELECT owner_id,scope_kind,COALESCE(contact_id,''),1 FROM main.memory WHERE owner_id=${row}.owner_id AND id=${row}.${column} ${upsert}`;
function dirty(where:string):string {
 // 已标脏的旧UPDATE仍应增加一次管理修订；首次标脏则由真正的memory更新计数。
 return `INSERT INTO notalone_management_scope_delta
 SELECT owner_id,scope_kind,COALESCE(contact_id,''),1 FROM main.memory WHERE ${where} AND management_timeline_dirty=1 ${upsert}
 UPDATE memory SET management_timeline_dirty=1 WHERE ${where} AND management_timeline_dirty=0;`;
}
function trigger(name:string,event:string,table:string,body:string):string {
 return `CREATE TEMP TRIGGER ${name} AFTER ${event} ON main.${table} BEGIN ${body} END;`;
}
const triggers=[
 ...['memory','memory_candidate'].flatMap(table=>['INSERT','UPDATE','DELETE'].map(operation=>
  trigger(`${table}_management_${operation.toLowerCase()}`,operation,table,direct(operation==='DELETE'?'OLD':'NEW')))),
 ...[['memory_version','memory_id'],['memory_decision','target_memory_id']].flatMap(([table,column])=>['INSERT','UPDATE','DELETE'].map(operation=>
  trigger(`${table}_management_${operation.toLowerCase()}`,operation,table,dependent(operation==='DELETE'?'OLD':'NEW',column)))),
 trigger('memory_timeline_update','UPDATE OF current_version_no,state','memory',`
  INSERT INTO notalone_management_scope_delta SELECT NEW.owner_id,NEW.scope_kind,COALESCE(NEW.contact_id,''),1 WHERE NEW.management_timeline_dirty=1 ${upsert}
  UPDATE memory SET management_timeline_dirty=1 WHERE owner_id=NEW.owner_id AND id=NEW.id AND management_timeline_dirty=0;`),
 ...['memory_version','memory_citation'].flatMap(table=>['INSERT','UPDATE','DELETE'].map(operation=>{
  const rows=operation==='UPDATE'?['OLD','NEW']:[operation==='DELETE'?'OLD':'NEW'];
  return trigger(`${table}_timeline_${operation.toLowerCase()}`,operation,table,rows.map(row=>dirty(`owner_id=${row}.owner_id AND id=${row}.memory_id AND current_version_no=${row}.version_no
   ${operation==='UPDATE'&&row==='OLD'?'AND (OLD.owner_id<>NEW.owner_id OR OLD.memory_id IS NOT NEW.memory_id OR OLD.version_no IS NOT NEW.version_no)':''}`)).join('\n'));
 })),
 trigger('message_timeline_time','UPDATE OF sent_at','message',dirty(`owner_id=NEW.owner_id AND id IN(
  SELECT citation.memory_id FROM main.memory_citation citation JOIN main.memory current
   ON current.owner_id=citation.owner_id AND current.id=citation.memory_id AND current.current_version_no=citation.version_no
  WHERE citation.owner_id=NEW.owner_id AND citation.source_contact_id=NEW.contact_id AND citation.message_id=NEW.id AND citation.memory_id IS NOT NULL)`)),
 trigger('management_contact_deleted','DELETE','contact',"DELETE FROM notalone_management_scope_delta WHERE owner_id=OLD.owner_id AND scope_kind='contact' AND contact_key=OLD.id;"),
 trigger('management_owner_deleted','DELETE','owner','DELETE FROM notalone_management_scope_delta WHERE owner_id=OLD.owner_id;'),
].join('\n');

/** 每个受控writer独享TEMP聚合。SQLite同时回滚业务行和修订增量，含SAVEPOINT回滚。
 * dirty首次置位立即可见，重复置位仅累加旧嵌套更新的修订；每个范围在读取或提交前结清一次。
 */
export function installManagementBatching(db:DatabaseSync):{begin():void;flush():void} {
 db.exec(`CREATE TEMP TABLE notalone_management_scope_delta(
 owner_id TEXT NOT NULL,scope_kind TEXT NOT NULL,contact_key TEXT NOT NULL,delta INTEGER NOT NULL CHECK(delta>0),
 PRIMARY KEY(owner_id,scope_kind,contact_key)) STRICT,WITHOUT ROWID;
 ${triggers}`);
 const pending=db.prepare('SELECT 1 FROM temp.notalone_management_scope_delta LIMIT 1');
 let failed=false,failure:unknown;
 return {
  begin(){failed=false;failure=undefined;},
  // 一次结清可能已更新多个范围；失败后要求整个动作回滚，不接受局部恢复后提交。
  flush(){
   if(failed)throw failure;
   if(!pending.get())return;
   try{
    db.exec(`UPDATE main.owner SET management_revision=management_revision+(
      SELECT delta FROM temp.notalone_management_scope_delta q WHERE q.owner_id=owner.owner_id AND q.scope_kind='self' AND q.contact_key='')
      WHERE owner_id IN(SELECT owner_id FROM temp.notalone_management_scope_delta WHERE scope_kind='self');
     UPDATE main.contact SET management_revision=management_revision+(
      SELECT delta FROM temp.notalone_management_scope_delta q WHERE q.owner_id=contact.owner_id AND q.scope_kind='contact' AND q.contact_key=contact.id)
      WHERE (owner_id,id) IN(SELECT owner_id,contact_key FROM temp.notalone_management_scope_delta WHERE scope_kind='contact');
     DELETE FROM temp.notalone_management_scope_delta;`);
   }catch(error){failed=true;failure=error;throw error;}
  },
 };
}
