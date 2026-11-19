import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {owner,record,fixture} from './fixtures/history/sync-support.mjs';
import {currentSourceScopeCTE,savedSourceScopeCTE} from '../src/history/sqlite/current-scope.ts';
import {incompleteLegacySource} from '../src/history/sqlite/source-proof.ts';

// 旧实现（每联系人对全部历史目标做 row_number 窗口排序）的冻结副本：只作差分对照，现行实现改写后结果必须与它逐字节相同。
function legacyScopeCTE(saved){return `history_scope_request AS MATERIALIZED (
 SELECT ? owner_id,? contact_scope,? contact_id
), retired_provisional_scope AS MATERIALIZED (
 SELECT p.owner_id,p.contact_id FROM source_proof p JOIN history_scope_request q ON q.owner_id=p.owner_id WHERE p.reason='${incompleteLegacySource}'
), current_history_ranked AS MATERIALIZED (
 SELECT h.owner_id,h.contact_id,h.binding_id,h.target_json,row_number() OVER(PARTITION BY h.owner_id,h.contact_id ORDER BY h.creation_no DESC) position
 FROM read_goal h JOIN history_scope_request q ON q.owner_id=h.owner_id AND q.contact_scope IS NOT NULL AND h.contact_id=q.contact_id
 WHERE NOT EXISTS(SELECT 1 FROM retired_provisional_scope p WHERE p.owner_id=h.owner_id AND p.contact_id=h.contact_id) AND h.kind='history' AND h.creation_no IS NOT NULL AND EXISTS(SELECT 1 FROM conversation_binding live WHERE live.owner_id=h.owner_id AND live.id=h.binding_id AND ${saved?"live.state<>'revoked'":"live.state='verified'"})
 UNION ALL
 SELECT h.owner_id,h.contact_id,h.binding_id,h.target_json,row_number() OVER(PARTITION BY h.owner_id,h.contact_id ORDER BY h.creation_no DESC) position
 FROM read_goal h JOIN history_scope_request q ON q.owner_id=h.owner_id AND q.contact_scope IS NULL
 WHERE NOT EXISTS(SELECT 1 FROM retired_provisional_scope p WHERE p.owner_id=h.owner_id AND p.contact_id=h.contact_id) AND h.kind='history' AND h.creation_no IS NOT NULL AND EXISTS(SELECT 1 FROM conversation_binding live WHERE live.owner_id=h.owner_id AND live.id=h.binding_id AND ${saved?"live.state<>'revoked'":"live.state='verified'"})
), current_history_scope AS MATERIALIZED (
 SELECT owner_id,contact_id,binding_id,target_json FROM current_history_ranked WHERE position=1
 UNION ALL
 SELECT c.owner_id,c.contact_id,b.id,json_object('sourceGeneration',c.source_generation,'partitions',json_extract(c.tables_json,'$.partitions'),'tables',json((
  SELECT json_group_array(json_object('partition',json_extract(t.value,'$[0]'),'instance',json_extract(t.value,'$[1]'))) FROM json_each(c.tables_json,'$.tables') t)))
 FROM source_proof c JOIN history_scope_request q ON q.owner_id=c.owner_id
 JOIN conversation_binding b ON b.owner_id=c.owner_id AND b.contact_id=c.contact_id AND b.conversation_id=c.conversation_id AND ${saved?"b.state<>'revoked'":"b.state='verified'"}
 WHERE (q.contact_scope IS NULL OR c.contact_id=q.contact_id) AND c.reason IS NOT '${incompleteLegacySource}' AND c.tables_json<>'' AND json_valid(c.tables_json)
 AND NOT EXISTS (SELECT 1 FROM current_history_ranked h WHERE h.owner_id=c.owner_id AND h.contact_id=c.contact_id)
), current_source_members AS MATERIALIZED (
 SELECT h.owner_id,h.contact_id,h.binding_id,json_extract(h.target_json,'$.sourceGeneration') generation,
 json_extract(t.value,'$.partition') partition,json_extract(t.value,'$.instance') instance,
 json_array(json_extract(h.target_json,'$.sourceGeneration'),json_extract(t.value,'$.partition'),json_extract(t.value,'$.instance')) closed_prefix
 FROM current_history_scope h JOIN json_each(h.target_json,'$.tables') t
), current_source_ranges AS MATERIALIZED (
 SELECT *,substr(closed_prefix,1,length(closed_prefix)-1)||',' prefix FROM current_source_members
)`;}

const j=value=>JSON.stringify(value,(_k,v)=>typeof v==='bigint'?`${v}n`:v);
const databaseFile=f=>join(f.root,'managed/sqlite/notalone.sqlite');

/** 三位联系人：A 最新两个目标的绑定已撤销（次新有效目标应成为当前）、B 最新目标绑定待确认、C 的临时来源证明已退役；每人另有增量目标和旧版（无序号）目标。 */
async function seeded(t){
 const f=await fixture(t,['a','b','c']);
 f.state.historyRecords=[record('1')];
 const candidate=await f.contacts.detectAccount();await f.contacts.confirmAccount(candidate.candidate_token);
 const snapshot=await f.contacts.candidates(true);
 await f.contacts.confirm(snapshot.snapshot_token,snapshot.sessions.map(row=>({locator:row.username,observed_display_name:row.display_name,expected_selection_generation:row.selection_generation})));
 await f.contacts.setReading(true);
 const bindings=(await f.contacts.directory()).bindings;assert.equal(bindings.length,3);
 for(const binding of bindings)await f.history.synchronize(binding.contact_id);
 const [a,b,c]=bindings.map(binding=>binding.contact_id);
 const db=new DatabaseSync(databaseFile(f),{enableForeignKeyConstraints:false});db.function('notalone_sha256',{deterministic:true},v=>v);
 try{
  const columns=db.prepare('SELECT name FROM pragma_table_info(?)').all('read_goal').map(x=>x.name);
  const insert=db.prepare(`INSERT INTO read_goal(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`);
  let creationNo=Number(db.prepare('SELECT max(creation_no) m FROM read_goal').get().m);
  const addBinding=(contactId,state)=>{
   const template=db.prepare('SELECT * FROM conversation_binding WHERE contact_id=? ORDER BY id LIMIT 1').get(contactId),id=randomUUID();
   db.prepare('INSERT INTO conversation_binding(owner_id,id,contact_id,conversation_id,identity_generation,state) VALUES(?,?,?,?,?,?)').run(template.owner_id,id,contactId,template.conversation_id,template.identity_generation,state);
   return id;
  };
  const goal=(contactId,{binding,kind='history',state='complete',legacy=false,label})=>{
   const template=db.prepare("SELECT * FROM read_goal WHERE contact_id=? AND kind='history' AND creation_no IS NOT NULL ORDER BY creation_no LIMIT 1").get(contactId);
   const target=JSON.parse(template.target_json);target.descriptor=`synthetic-${label}`;
   const row={...template,id:`seed-${label}`,kind,state,binding_id:binding??template.binding_id,target_json:JSON.stringify(target),target_descriptor:target.descriptor,
    creation_no:legacy?null:BigInt(++creationNo),created_at:BigInt(template.created_at)+BigInt(creationNo),handoff_from_goal_id:null,cursor:null,resume_cursor:null};
   insert.run(...columns.map(column=>row[column]));return row.id;
  };
  const liveA=db.prepare('SELECT binding_id FROM read_goal WHERE contact_id=? LIMIT 1').get(a).binding_id;
  const revokedA1=addBinding(a,'revoked'),revokedA2=addBinding(a,'revoked');
  goal(a,{label:'a-old-1'});goal(a,{label:'a-old-2'});goal(a,{label:'a-live',binding:liveA});goal(a,{label:'a-inc',kind:'incremental',state:'invalidated',binding:liveA});
  goal(a,{label:'a-rev-1',binding:revokedA1});goal(a,{label:'a-rev-2',binding:revokedA2});goal(a,{label:'a-legacy',legacy:true,binding:liveA});
  const pendingB=db.prepare('SELECT binding_id FROM read_goal WHERE contact_id=? LIMIT 1').get(b).binding_id;
  goal(b,{label:'b-old',binding:addBinding(b,'revoked')});db.prepare("UPDATE conversation_binding SET state='needs_confirmation' WHERE id=?").run(pendingB);goal(b,{label:'b-new',binding:pendingB});
  goal(c,{label:'c-old'});goal(c,{label:'c-new'});
  db.prepare('UPDATE source_proof SET reason=? WHERE contact_id=?').run(incompleteLegacySource,c);
 }finally{db.close();}
 return {f,a,b,c,bindings};
}
const rowsOf=(db,cte,params,select)=>db.prepare(`WITH ${cte} ${select}`).all(...params);
const scopeSelect='SELECT owner_id,contact_id,binding_id,target_json FROM current_history_scope ORDER BY owner_id,contact_id,binding_id,target_json';
const rangesSelect='SELECT owner_id,contact_id,binding_id,generation,partition,instance,prefix FROM current_source_ranges ORDER BY contact_id,binding_id,partition,instance';
const firstSelect='SELECT owner_id,contact_id,binding_id,target_json FROM current_history_ranked WHERE position=1 ORDER BY contact_id';

test('当前历史范围与旧排序实现逐字节相同（全联系人／单联系人 × verified／saved × 撤销、待确认、退役临时证明）',async t=>{
 const ctx=await seeded(t);const db=new DatabaseSync(databaseFile(ctx.f),{readOnly:true});t.after(()=>db.close());
 const scopes=[['all',[owner,null,null]],['a',[owner,1,ctx.a]],['b',[owner,1,ctx.b]],['c',[owner,1,ctx.c]],['missing',[owner,1,'no-such-contact']]];
 let compared=0;
 for(const [label,params] of scopes)for(const [name,current,legacy] of [['verified',currentSourceScopeCTE,legacyScopeCTE(false)],['saved',savedSourceScopeCTE,legacyScopeCTE(true)]])for(const select of [scopeSelect,rangesSelect,firstSelect]){
  assert.equal(j(rowsOf(db,current,params,select)),j(rowsOf(db,legacy,params,select)),`${label}/${name}/${select.slice(0,40)}`);compared++;
 }
 assert.equal(compared,30);
});

test('每联系人只取最新的有效绑定历史目标：撤销绑定顺延到次新有效目标，待确认只在 saved 范围可见（撤销始终不可见），退役临时证明整体排除',async t=>{
 const ctx=await seeded(t);const db=new DatabaseSync(databaseFile(ctx.f),{readOnly:true});t.after(()=>db.close());
 const first=(cte,contact)=>rowsOf(db,cte,[owner,null,null],firstSelect).filter(row=>row.contact_id===contact).map(row=>JSON.parse(row.target_json).descriptor);
 // A：最新两个目标绑定已撤销，增量与旧版（无序号）目标不参与；当前为 seed-a-live。
 assert.deepEqual(first(currentSourceScopeCTE,ctx.a),['synthetic-a-live']);
 assert.deepEqual(first(savedSourceScopeCTE,ctx.a),['synthetic-a-live']);
 // B：最新目标绑定待确认、上一目标绑定已撤销——verified 范围没有当前目标，saved 范围取最新（撤销的仍不可见）。
 assert.deepEqual(first(currentSourceScopeCTE,ctx.b),[]);
 assert.deepEqual(first(savedSourceScopeCTE,ctx.b),['synthetic-b-new']);
 // C：临时来源证明已退役，两种范围都不产生当前目标。
 assert.deepEqual(first(currentSourceScopeCTE,ctx.c),[]);assert.deepEqual(first(savedSourceScopeCTE,ctx.c),[]);
 const scopeA=rowsOf(db,currentSourceScopeCTE,[owner,1,ctx.a],scopeSelect);assert.equal(scopeA.length,1);assert.equal(scopeA[0].contact_id,ctx.a);
});

test('读取入口：覆盖与目录按当前历史目标计算，结果随服务重复读取稳定',async t=>{
 const ctx=await seeded(t),{f}=ctx;
 const coverageA=await f.history.coverage(ctx.a),coverageB=await f.history.coverage(ctx.b);
 const db=new DatabaseSync(databaseFile(f),{readOnly:true});t.after(()=>db.close());
 const binding=id=>db.prepare('SELECT binding_id FROM read_goal WHERE id=?').get(id).binding_id;
 assert.equal(coverageA.goalId,'seed-a-live');assert.equal(coverageA.bindingId,binding('seed-a-live'));
 assert.equal(coverageB.goalId,null);
 const reads=[await f.history.read(ctx.a),await f.contacts.directory()];
 assert.equal(j(reads),j([await f.history.read(ctx.a),await f.contacts.directory()]));
 assert.equal(reads[0].coverage.goalId,'seed-a-live');
});
