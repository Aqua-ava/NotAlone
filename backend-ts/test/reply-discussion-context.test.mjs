import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {setup} from './reply-assistant-erasure-support.mjs';
import {ReplyAssistantGuards} from '../src/reply/generation/reply-assistant-guards.ts';
import * as source from '../src/reply/generation/reply-source-guards.ts';
import {PostgresReplyDiscussionContext,assistantDiscussionPayload,continuationReferencePayload} from '../src/reply/discussion/reply-discussion-context.ts';
import {fingerprint,canonical,inputRows,generationDependencies} from '../src/reply/generation/reply-assistant-erasure.ts';
function assistant(x){let guards;const discussion=(c,s,r)=>guards.requireReplyDiscussionById(c,s,r);const ports={...source,requireReplySourcesCurrent:(c,s,r,h)=>source.requireReplySourcesCurrent(c,s,r,h,discussion),requireCurrentReplyMemory:async()=>{},requireSavedSkillPolicy:async()=>{},requireActiveBinding:async()=>x.binding,navigationDependencyIds:()=>[]};guards=new ReplyAssistantGuards(ports);return {guards,ports};}
function service(x){return new PostgresReplyDiscussionContext(assistant(x));}
async function request(x,g){const r=(await x.f.client.query('SELECT * FROM reply_request WHERE id=$1',[g.request])).rows[0];return {...r,request_id:r.id};}
test('单次只读记录作用域返回深副本并保留旧小数，独立嵌套或结束后必须重读',async t=>{
 const x=await setup(t),dependency=randomUUID(),alternate=randomUUID(),g=await x.generation([dependency]),scope={owner_id:x.owner,contact_id:x.contact};
 const payload=text=>'{'+'"content":{"type":"reply_to_message","text":'+JSON.stringify(text)+',"nested":{"values":["one"]}},"synthetic_number":1.0}';
 await x.f.client.query('UPDATE assistant_session_turn SET input_payload=$2::jsonb WHERE id=$1',[g.turn,payload('合成旧输入')]);
 const other=new pg.Client({host:'/tmp',database:x.f.client.database,user:x.f.client.user});await other.connect();
 let release,late;const gate=new Promise(resolve=>{release=resolve;});
 await x.f.client.query('BEGIN');
 try{
  await x.f.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${x.owner}`]);
  await source.withReplyValidationScope(x.f.client,scope,async()=>{
   const first=(await inputRows(x.f.client,x.owner,x.contact,x.session))[0];first.input_payload.content.nested.values.push('污染');first.turn_dependencies.push(alternate);first.dependency_ids.push(alternate);
   const copy=(await inputRows(x.f.client,x.owner,x.contact,x.session))[0];assert.deepEqual(copy.input_payload.content.nested.values,['one']);assert.deepEqual(copy.turn_dependencies,[dependency]);assert.deepEqual(copy.dependency_ids,[]);assert.match(canonical(copy.input_payload),/"synthetic_number":1\.0/);
   const ids=await generationDependencies(x.f.client,x.owner,x.contact,{reply_request_id:g.request,turn_dependencies:[dependency]});ids.push(alternate);
   assert.deepEqual(await generationDependencies(x.f.client,x.owner,x.contact,{reply_request_id:g.request,turn_dependencies:[dependency]}),[dependency]);assert.deepEqual(await generationDependencies(x.f.client,x.owner,x.contact,{reply_request_id:g.request,turn_dependencies:[alternate]}),[alternate]);
   assert.deepEqual(await inputRows(x.f.client,x.owner,randomUUID(),x.session),[]);assert.deepEqual(await inputRows(x.f.client,randomUUID(),x.contact,x.session),[]);
   await source.withReplyValidationScope(x.f.client,scope,async()=>{await x.f.client.query('UPDATE assistant_session_turn SET input_payload=$2::jsonb WHERE id=$1',[g.turn,payload('合成子scope输入')]);});
   assert.equal((await inputRows(x.f.client,x.owner,x.contact,x.session))[0].input_payload.content.text,'合成子scope输入','独立子scope完成后不能恢复外层旧缓存');
   assert.equal((await inputRows(other,x.owner,x.contact,x.session))[0].input_payload.content.text,'合成旧输入','不同client不能复用本事务未提交记录');
   late=gate.then(()=>inputRows(x.f.client,x.owner,x.contact,x.session));
  });
  await x.f.client.query('UPDATE assistant_session_turn SET input_payload=$2::jsonb WHERE id=$1',[g.turn,payload('合成作用域后输入')]);release();assert.equal((await late)[0].input_payload.content.text,'合成作用域后输入');
  await x.f.client.query('COMMIT');
 }finally{release();await x.f.client.query('ROLLBACK');await other.end();}
});
test('原始依赖身份失败不缓存，修复损坏依据后同次只读作用域可重新核验',async t=>{
 const x=await setup(t),g=await x.generation(),evidence=randomUUID(),scope={owner_id:x.owner,contact_id:x.contact};
 await x.f.client.query("INSERT INTO reply_context_evidence(reply_request_id,owner_id,contact_id,evidence_id,conversation_binding_id,ordinal,kind,source_ids,evidence_text)VALUES($1,$2,$3,$4,$5,0,'owner_memory',$6,'合成损坏依据')",[g.request,x.owner,x.contact,evidence,x.binding,JSON.stringify([x.owner])]);
 await source.withReplyValidationScope(x.f.client,scope,async()=>{
  await assert.rejects(generationDependencies(x.f.client,x.owner,x.contact,{reply_request_id:g.request,turn_dependencies:[]}),{code:'assistant_erasure_identity_invalid'});
  // 仅此负例在失败后修复损坏夹具；正常读取作用域不执行写入。
  await x.f.client.query('DELETE FROM reply_context_evidence WHERE reply_request_id=$1 AND evidence_id=$2',[g.request,evidence]);
  assert.deepEqual(await generationDependencies(x.f.client,x.owner,x.contact,{reply_request_id:g.request,turn_dependencies:[]}),[]);
 });
});
test('嵌套复验保留外层递归检测，子作用域结束不能清除外层活动来源',async t=>{
 const x=await setup(t),a=await x.generation(),b=await x.generation(),scope={owner_id:x.owner,contact_id:x.contact};
 let visits=0;
 const discussion=async(client,current)=>{
  if(++visits>1)throw new Error('循环未在数据库递归前拒绝');
  await source.withReplyValidationScope(client,current,()=>source.requireReplySourcesCurrent(client,current,b.request,false));
  await source.withReplyValidationScope(client,{...current,contact_id:randomUUID()},()=>source.requireReplySourcesCurrent(client,current,a.request,false,discussion));
 };
 await assert.rejects(source.withReplyValidationScope(x.f.client,scope,()=>source.requireReplySourcesCurrent(x.f.client,scope,a.request,false,discussion)),{code:'reply_context_invalidated'});
 assert.equal(visits,1);
});
test('来源复验缓存隔离联系人、历史模式和守卫，失败不缓存并返回副本',async t=>{
 const x=await setup(t),g=await x.generation(),scope={owner_id:x.owner,contact_id:x.contact};
 let firstCalls=0,secondCalls=0,failed=true;
 const first=async()=>{firstCalls++;},second=async()=>{secondCalls++;if(failed)throw new Error('合成失败');};
 await source.withReplyValidationScope(x.f.client,scope,async()=>{
  const result=await source.requireReplySourcesCurrent(x.f.client,scope,g.request,false,first);result.push(randomUUID());
  assert.deepEqual(await source.requireReplySourcesCurrent(x.f.client,scope,g.request,false,first),[]);
  await source.requireReplySourcesCurrent(x.f.client,scope,g.request,true,first);assert.equal(firstCalls,2);
  await assert.rejects(source.requireReplySourcesCurrent(x.f.client,{...scope,contact_id:randomUUID()},g.request,false,first),{code:'reply_context_invalidated'});
  await assert.rejects(source.requireReplySourcesCurrent(x.f.client,{...scope,owner_id:randomUUID()},g.request,false,first),{code:'reply_context_invalidated'});
  await assert.rejects(source.requireReplySourcesCurrent(x.f.client,scope,g.request,false,second),/合成失败/);
  failed=false;await source.requireReplySourcesCurrent(x.f.client,scope,g.request,false,second);assert.equal(secondCalls,2);
  await source.withReplyValidationScope(x.f.client,scope,()=>source.requireReplySourcesCurrent(x.f.client,scope,g.request,false,first));assert.equal(firstCalls,3);
 });
 await source.requireReplySourcesCurrent(x.f.client,scope,g.request,false,first);assert.equal(firstCalls,4);
});
test('复验不跨数据库连接共享成功结果，导航按联系人隔离且结束后失效',async t=>{
 const x=await setup(t),g=await x.generation(),scope={owner_id:x.owner,contact_id:x.contact},id=randomUUID(),next=randomUUID();
 const database=(await x.f.client.query('SELECT current_database() AS name')).rows[0].name;
 const other=new pg.Client({host:'/tmp',database});await other.connect();
 const update=ids=>x.f.client.query('UPDATE reply_request SET context_snapshot=$2 WHERE id=$1',[g.request,JSON.stringify({navigation_dependency_ids:ids})]);
 await update([id]);let calls=0,release,delayed;
 const guard=async()=>{calls++;},gate=new Promise(resolve=>{release=resolve;});
 try{
  await source.withReplyValidationScope(x.f.client,scope,async()=>{
   await source.requireReplySourcesCurrent(x.f.client,scope,g.request,false,guard);
   await source.requireReplySourcesCurrent(other,scope,g.request,false,guard);assert.equal(calls,2);
   const registered=await source.registeredNavigationDependencies(x.f.client,scope);assert.deepEqual(registered,[id]);registered.length=0;
   assert.deepEqual(await source.registeredNavigationDependencies(x.f.client,scope),[id]);
   assert.deepEqual(await source.registeredNavigationDependencies(x.f.client,{...scope,contact_id:randomUUID()}),[]);
   assert.deepEqual(await source.registeredNavigationDependencies(x.f.client,{...scope,owner_id:randomUUID()}),[]);
   delayed=gate.then(()=>source.registeredNavigationDependencies(x.f.client,scope));
  });
  await update([next]);release();assert.deepEqual(await delayed,[next]);
 }finally{release();await other.end();}
});
test('保存候选的完整讨论复验复用历史来源，独立复验重新查询',async t=>{
 const x=await setup(t),services=assistant(x),s=new PostgresReplyDiscussionContext(services),memory=randomUUID();
 await x.f.client.query("INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,source_ids,adoption_method)VALUES($1,$2,$3,'合成偏好','preference',$4,'manual')",[memory,x.owner,x.contact,[x.contact]]);
 for(let index=0;index<3;index++){
  const g=await x.generation([memory]),r=await request(x,g),d=await s.read(x.f.client,r);
  await services.guards.captureReplyDiscussion(x.f.client,r,d.snapshot);
 }
 const g=await x.generation(),r=await request(x,g),d=await s.read(x.f.client,r);
 await services.guards.captureReplyDiscussion(x.f.client,r,d.snapshot);
 const query=x.f.client.query.bind(x.f.client);let navigation=0;const sources=new Map();
 x.f.client.query=(sql,...args)=>{
  if(typeof sql==='string'&&sql.includes('jsonb_path_query(turn.prepared_context'))navigation++;
  if(sql==='SELECT 1 FROM reply_request WHERE id=$1 AND owner_id=$2 AND contact_id=$3')sources.set(args[0][0],(sources.get(args[0][0])??0)+1);
  return query(sql,...args);
 };
 try{
  for(let pass=0;pass<2;pass++){
   navigation=0;sources.clear();
   assert.deepEqual(await services.guards.requireReplyDiscussion(x.f.client,r,d.snapshot,true),[memory]);
   assert.equal(navigation,1,'同次保存前完整复验应共享导航注册读取');
   assert.equal(sources.size,4);assert([...sources.values()].every(count=>count===1),'历史来源递归图应在一次复验内去重');
  }
 }finally{x.f.client.query=query;}
});
test('单次完整讨论复验只扫描一次导航并去重历史来源，下次复验重新读取',async t=>{
 const x=await setup(t),s=service(x);
 for(let index=0;index<3;index++){
  const generation=await x.generation(),r=await request(x,generation),discussion=await s.read(x.f.client,r);
  await x.f.client.query('UPDATE reply_request SET context_snapshot=$2 WHERE id=$1',
   [generation.request,JSON.stringify({assistant_discussion_snapshot:discussion.snapshot})]);
 }
 const current=await x.generation(),r=await request(x,current),query=x.f.client.query.bind(x.f.client);
 let navigation=0;const sourceReads=new Map();
 x.f.client.query=(sql,...args)=>{
  if(typeof sql==='string'&&sql.includes('jsonb_path_query(turn.prepared_context'))navigation++;
  if(sql==='SELECT 1 FROM reply_request WHERE id=$1 AND owner_id=$2 AND contact_id=$3')sourceReads.set(args[0][0],(sourceReads.get(args[0][0])??0)+1);
  return query(sql,...args);
 };
 try{
  const first=await s.read(x.f.client,r);
  assert.equal(navigation,1,'同次只读讨论装配不能逐条重扫导航注册表');
  assert.equal(sourceReads.size,4);
  assert([...sourceReads.values()].every(count=>count===1),'共享历史来源在同次复验中只校验一次');
  navigation=0;sourceReads.clear();
  await s.validateCurrent(x.f.client,r,first);
  assert.equal(navigation,1,'独立提交复验必须重新查询，不能沿用前一阶段缓存');
  assert.equal(sourceReads.size,4);
  assert([...sourceReads.values()].every(count=>count===1));
 }finally{x.f.client.query=query;}
});
test('实际PG完整历史保留旧用户输入，当前输入不重复进入历史',async t=>{
 const x=await setup(t),old=await x.generation(),current=await x.generation(),s=service(x),r=await request(x,current);
 const discussion=await s.read(x.f.client,r),payload=assistantDiscussionPayload(discussion);
 assert.equal(payload.weight,'low');assert.equal(payload.items.length,1);assert.equal(payload.items[0].input_version_id,old.input);assert.equal(payload.items[0].is_sent,false);
 assert.equal(JSON.parse(payload.items[0].text).content.text,'合成输入');await s.validateCurrent(x.f.client,r,discussion);
});
async function candidate(x,g){const id=randomUUID(),group=[{message_id:randomUUID(),text:'合成原版'}];await x.f.client.query("UPDATE reply_request SET state='completed',context_snapshot='{}',skill_library_revision=0 WHERE id=$1",[g.request]);await x.f.client.query("UPDATE assistant_session_turn SET state='completed' WHERE id=$1",[g.turn]);await x.f.client.query("INSERT INTO reply_candidate(id,reply_request_id,owner_id,contact_id,conversation_binding_id,ordinal,candidate_text,basis,risk_notes,message_group)VALUES($1,$2,$3,$4,$5,0,'合成原版','合成依据','[]',$6)",[id,g.request,x.owner,x.contact,x.binding,JSON.stringify(group)]);return {id,group};}
async function original(x,g,c){await x.f.client.query('INSERT INTO assistant_candidate_version(id,owner_id,contact_id,session_id,turn_id,candidate_id,version_number)VALUES($1,$2,$3,$4,$5,$1,0)',[c.id,x.owner,x.contact,g.session,g.turn]);}
async function edit(x,g,c,parent,n){const id=randomUUID(),group=[{message_id:c.group[0].message_id,text:`合成编辑${n}`}];await x.f.client.query('INSERT INTO assistant_candidate_version(id,owner_id,contact_id,session_id,turn_id,candidate_id,version_number,parent_version_id,edit_key,message_group,requirements)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id,x.owner,x.contact,g.session,g.turn,c.id,n,parent,randomUUID(),JSON.stringify(group),'更自然']);return {id,group};}
async function rawSource(x){const id=randomUUID();await x.f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)VALUES($1,$2,$3,'wechat_jsonl','synthetic.jsonl',$4,1)",[id,x.owner,x.contact,id.replaceAll('-','').repeat(2)]);return id;}
test('准备依赖保留混合记录及仅候选版本的完整非空来源集合',async t=>{
 const x=await setup(t),a=await rawSource(x),b=await rawSource(x),old=await x.generation([a]),c=await candidate(x,old);await original(x,old,c);
 await x.f.client.query("INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,input_type,content,dependency_ids)VALUES($1,$2,$3,$4,$5,'purpose_exploration',$6,$7)",[randomUUID(),x.session,x.owner,x.contact,x.binding,JSON.stringify({type:'purpose_exploration',text:'合成混合讨论'}),[b]]);
 const current=await x.generation(),s=service(x),identity={owner_id:x.owner,contact_id:x.contact,conversation_binding_id:x.binding,idempotency_key:current.key},d=await s.readPreparation(x.f.client,identity);
 assert.deepEqual(await s.preparationDependencies(x.f.client,identity,d),[a,b].sort());assert.deepEqual([...new Set(d.items.map(item=>item.kind))].sort(),['candidate_version','discussion_input','generation_input']);
 const selected={...d,items:d.items.filter(item=>item.kind==='candidate_version'),snapshot:{...d.snapshot,records:d.snapshot.records.filter(record=>record.kind==='candidate_version')}};
 assert.deepEqual(await s.preparationDependencies(x.f.client,identity,selected),[a]);
 t.diagnostic('准备依赖语义 '+JSON.stringify({mixed:['source-a','source-b'],candidate_only:['source-a'],public_fields:Object.keys(d).sort()}));
});
test('原版只读不补版本，完整编辑与选择逐字进入低权重模型投影',async t=>{
 const x=await setup(t),old=await x.generation(),c=await candidate(x,old),g=await x.generation(),s=service(x),r=await request(x,g);
 const initial=await s.read(x.f.client,r);assert.equal(initial.items.filter(i=>i.kind==='candidate_version').length,1);assert.equal((await x.f.client.query('SELECT 1 FROM assistant_candidate_version')).rowCount,0);
 await original(x,old,c);const v1=await edit(x,old,c,c.id,1),v2=await edit(x,old,c,v1.id,2);
 await x.f.client.query('INSERT INTO assistant_candidate_selection(id,owner_id,contact_id,session_id,selection_key,selection_number,candidate_id,version_id)VALUES($1,$2,$3,$4,$5,1,$6,$7)',[randomUUID(),x.owner,x.contact,x.session,randomUUID(),c.id,v1.id]);
 const d=await s.read(x.f.client,r),items=assistantDiscussionPayload(d).items.filter(i=>i.kind==='candidate_version');
 assert.equal(items.length,3);assert.deepEqual(items.map(i=>[i.version_number,i.is_default_display,i.is_explicitly_selected,i.is_sent]),[[0,false,false,false],[1,false,true,false],[2,true,false,false]]);
 const auth={continuation:{candidate_id:c.id,version_id:v1.id},continuation_reference:{candidate_id:c.id,version_id:v1.id,messages:v1.group}},scope={owner_id:x.owner,contact_id:x.contact};
 const selected=continuationReferencePayload(d,scope,c.id,{type:'reply_to_message'},auth);assert.deepEqual(selected.messages,v1.group);assert.equal(selected.weight,'low');
 const draft=continuationReferencePayload(d,scope,c.id,{type:'rewrite_draft',draft_text:'合成编辑1'},auth);assert.equal(draft.is_current_draft,true);assert.equal(Object.hasOwn(draft,'messages'),false);
 assert.throws(()=>continuationReferencePayload(d,scope,c.id,{type:'reply_to_message'},{...auth,continuation_reference:{...auth.continuation_reference,messages:c.group}}),{code:'reply_context_invalidated'});
 await edit(x,old,c,v2.id,3);await s.validateCurrent(x.f.client,r,d);
 await x.f.client.query("UPDATE assistant_candidate_version SET requirements='篡改要求' WHERE id=$1",[v1.id]);await assert.rejects(s.validateCurrent(x.f.client,r,d));
});
test('当前指针与绑定变化拒绝，异联系人不能读取讨论',async t=>{
 const x=await setup(t),g=await x.generation(),r=await request(x,g),s=service(x),d=await s.read(x.f.client,r);
 await assert.rejects(s.read(x.f.client,{...r,contact_id:randomUUID()}),{code:'reply_context_invalidated'});
 await assert.rejects(s.read(x.f.client,{...r,conversation_binding_id:randomUUID()}),{code:'reply_context_invalidated'});
 await x.generation();await assert.rejects(s.validateCurrent(x.f.client,r,d),{code:'reply_context_invalidated'});
});
test('失效历史不会进入新模型上下文，已捕获历史失效则拒绝提交',async t=>{
 const x=await setup(t),memory=randomUUID();await x.f.client.query("INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,source_ids,adoption_method)VALUES($1,$2,$3,'合成偏好','preference',$4,'manual')",[memory,x.owner,x.contact,[x.contact]]);
 const old=await x.generation([memory]),g=await x.generation(),r=await request(x,g),s=service(x),d=await s.read(x.f.client,r);assert.equal(d.items.length,1);
 await x.f.client.query("UPDATE confirmed_memory SET status='invalidated' WHERE id=$1",[memory]);
 assert.equal((await s.read(x.f.client,r)).items.length,0);await assert.rejects(s.validateCurrent(x.f.client,r,d),{code:'reply_context_invalidated'});
});
test('跨会话携入只采用真实选择版本及完整依赖，伪造指纹不进入模型',async t=>{
 const x=await setup(t),dependency=await rawSource(x),old=await x.generation([dependency]),c=await candidate(x,old);await original(x,old,c);const selection=randomUUID(),other=randomUUID(),carry=randomUUID();
 await x.f.client.query('INSERT INTO assistant_candidate_selection(id,owner_id,contact_id,session_id,selection_key,selection_number,candidate_id,version_id)VALUES($1,$2,$3,$4,$5,1,$6,$6)',[selection,x.owner,x.contact,x.session,randomUUID(),c.id]);
 await x.f.client.query('INSERT INTO assistant_session(id,owner_id,contact_id,is_default)VALUES($1,$2,$3,false)',[other,x.owner,x.contact]);
 const origin={type:'candidate_carry',metadata_version:2,origin_owner_id:x.owner,origin_contact_id:x.contact,origin_binding_id:x.binding,origin_session_id:x.session,origin_input_version_id:old.input,origin_turn_id:old.turn,origin_reply_request_id:old.request,origin_candidate_id:c.id,origin_version_id:c.id,origin_selection_id:selection,payload_sha256:fingerprint(c.group)};
 await x.f.client.query("INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,input_type,content,dependency_ids)VALUES($1,$2,$3,$4,$5,'candidate_carry',$6,$7)",[carry,other,x.owner,x.contact,x.binding,JSON.stringify(origin),[dependency]]);
 const g=await x.generation([],null,other),r=await request(x,g),s=service(x),d=await s.read(x.f.client,r);assert.equal(d.items.length,1);assert.equal(d.items[0].kind,'candidate_carry');assert.deepEqual(JSON.parse(d.items[0].text),{messages:c.group});await s.validateCurrent(x.f.client,r,d);
 assert.deepEqual(await s.preparationDependencies(x.f.client,{owner_id:x.owner,contact_id:x.contact,conversation_binding_id:x.binding,idempotency_key:g.key},d),[dependency]);t.diagnostic('携入依赖语义 '+JSON.stringify({candidate_carry:['source-a'],public_fields:Object.keys(d).sort()}));
 await x.f.client.query('UPDATE assistant_session_input SET content=$2 WHERE id=$1',[carry,JSON.stringify({...origin,payload_sha256:'0'.repeat(64)})]);assert.equal((await s.read(x.f.client,r)).items.length,0);await assert.rejects(s.validateCurrent(x.f.client,r,d));
});
test('普通讨论完整保留且非整数JSON指纹兼容，无锚点仅兼容旧入口',async t=>{
 const x=await setup(t),id=randomUUID(),g=await x.generation(),r=await request(x,g),s=service(x),body='合成讨论'.repeat(1000);
 await x.f.client.query("INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,input_type,content)VALUES($1,$2,$3,$4,$5,'purpose_exploration',$6::jsonb)",[id,x.session,x.owner,x.contact,x.binding,'{"type":"purpose_exploration","text":'+JSON.stringify(body)+',"synthetic_number":1.0}']);
 const d=await s.read(x.f.client,r);assert.equal(d.items.length,1);assert.equal(JSON.parse(d.items[0].text).text,body);assert.match(d.items[0].text,/"synthetic_number":1\.0/);await s.validateCurrent(x.f.client,r,d);
 await assert.rejects(s.validateCurrent(x.f.client,r,null),{code:'reply_context_invalidated'});
 const legacy={...r,request_id:randomUUID(),idempotency_key:randomUUID()};await x.f.client.query("INSERT INTO reply_request(id,owner_id,contact_id,conversation_binding_id,idempotency_key,normalized_input,state,attempt,lease_expires_at)VALUES($1,$2,$3,$4,$5,'synthetic','running',1,now()+interval '30 seconds')",[legacy.request_id,x.owner,x.contact,x.binding,legacy.idempotency_key]);assert.equal(await s.read(x.f.client,legacy),null);await s.validateCurrent(x.f.client,legacy,null);
 const tampered={...d,items:d.items.map(i=>({...i,text:'伪造历史'}))};await assert.rejects(s.validateCurrent(x.f.client,r,tampered),{code:'reply_context_invalidated'});
});
test('真实A准备在没有C请求时读取完整讨论与CAS，不创建占位回复',async t=>{
 const x=await setup(t),old=await x.generation(),g=await x.generation(),s=service(x);
 await x.f.client.query('UPDATE assistant_session_turn SET reply_request_id=NULL WHERE id=$1',[g.turn]);await x.f.client.query('DELETE FROM reply_request WHERE id=$1',[g.request]);
 const identity={owner_id:x.owner,contact_id:x.contact,conversation_binding_id:x.binding,idempotency_key:g.key},d=await s.readPreparation(x.f.client,identity);assert.equal(d.items[0].input_version_id,old.input);await s.validatePreparation(x.f.client,identity,d);
 assert.equal((await x.f.client.query('SELECT 1 FROM reply_request WHERE idempotency_key=$1',[g.key])).rowCount,0);
 await x.generation();await assert.rejects(s.validatePreparation(x.f.client,identity,d),{code:'reply_context_invalidated'});await assert.rejects(s.readPreparation(x.f.client,{...identity,idempotency_key:randomUUID()}),{code:'reply_context_invalidated'});
});
