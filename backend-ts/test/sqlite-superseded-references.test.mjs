import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {retainingReferences,ownedReferences} from '../src/history/sqlite/superseded.ts';

/**
 * 新增表引用 message／capture_record 而没有登记，被取代副本清理就可能删掉仍被引用的消息，
 * 或在外键处失败。本测试按真实 DDL 枚举全库，要求每张这样的表都已登记到引用表或附属表。
 */
test('全库枚举：每张引用消息或来源记录的表都已登记为“保留引用”或“随消息清理的附属表”',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-superseded-refs-')));
 const storage=await SqliteStorage.open({userData:root,intent:'create',role:'test'});
 t.after(async()=>{await storage.close().catch(()=>{});await rm(root,{recursive:true,force:true});});
 const path=join(root,'managed/sqlite/notalone.sqlite');
 await storage.close();
 const db=new DatabaseSync(path,{readOnly:true});t.after(()=>db.close());
 const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name);
 const referencing=new Map();
 for(const table of tables){
  const columns=db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map(r=>r.name);
  const foreign=db.prepare(`SELECT DISTINCT "table" target FROM pragma_foreign_key_list('${table}')`).all().map(r=>r.target);
  const byColumn=columns.filter(name=>/(^|_)(message_id|record_id)$/.test(name)&&!['source_attempt_id'].includes(name));
  const byForeign=foreign.filter(target=>target==='message'||target==='capture_record');
  if(byColumn.length||byForeign.length)referencing.set(table,{columns:byColumn,foreign:byForeign});
 }
 const self=new Set(['message','capture_record']);
 const registered=new Set([...retainingReferences.map(r=>r.table),...ownedReferences,'message_alias']);
 for(const [table,detail] of referencing){
  if(self.has(table))continue;
  assert.ok(registered.has(table),`表 ${table} 引用 message／capture_record（列 ${detail.columns.join(',')||'无'}；外键 ${detail.foreign.join(',')||'无'}）但未登记到 superseded.ts 的 retainingReferences 或 ownedReferences`);
 }
 // 反向：登记的表必须真实存在，且声明的列存在；保留引用必须真的引用消息或来源记录。
 for(const ref of retainingReferences){
  assert.ok(tables.includes(ref.table),`${ref.table} 已不存在，请更新登记`);
  const columns=db.prepare(`SELECT name FROM pragma_table_info('${ref.table}')`).all().map(r=>r.name);
  for(const column of [ref.contactColumn,ref.recordColumn,ref.messageColumn].filter(Boolean))assert.ok(columns.includes(column),`${ref.table}.${column} 不存在`);
  assert.ok(referencing.has(ref.table),`${ref.table} 不再引用 message／capture_record`);
 }
 for(const table of ownedReferences)assert.ok(tables.includes(table),`${table} 已不存在，请更新登记`);
 // 保留引用的 SQL 能在真实 DDL 上准备成功（列名、联系人列拼写错误会在此暴露）。
 for(const ref of retainingReferences){
  if(ref.recordColumn)db.prepare(`SELECT 1 FROM ${ref.table} WHERE owner_id=? AND ${ref.contactColumn}=? AND ${ref.recordColumn} IS NOT NULL`);
  if(ref.messageColumn)db.prepare(`SELECT 1 FROM ${ref.table} WHERE owner_id=? AND ${ref.contactColumn}=? AND ${ref.messageColumn} IS NOT NULL`);
 }
});
