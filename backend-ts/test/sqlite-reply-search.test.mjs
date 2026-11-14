import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {fixture,owner,record} from './fixtures/memory-sqlite/support.mjs';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';
import {SqliteDiscussionService} from '../src/reply/sqlite/service.ts';
import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';
import {createMemoryKnowledgeReader} from '../src/memory/sqlite/management/knowledge.ts';
import {assertReplyLocalSource} from '../src/history/sqlite/reply-local-source.ts';
import {initializeReplySearch,beginReplySearch,finishReplySearch} from '../src/reply/sqlite/candidates/search.ts';
import {freezeReplyInput,requireReplyInput} from '../src/reply/sqlite/candidates/input.ts';
import {withReplyValidation} from '../src/reply/sqlite/candidates/validation.ts';
import {dropSkillContext} from '../src/reply/sqlite/skill-fallback.ts';
import {DeletionService} from '../src/storage/sqlite/deletion/service.ts';
import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';
import {createReplyKnowledgeStorageRegistry} from '../src/reply/sqlite/candidates/knowledge-context.ts';
import {memoryManagementDeletionDomain} from '../src/memory/sqlite/management/deletion.ts';
import {sha256} from '../src/platform/sha256.ts';

async function setup(t,{count=2,background=true,initialFirst=false,messageText=index=>`园艺聊天${index+1}`}={}){
 const f=await fixture(t),contactId=f.saved[0].contact_id;
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:Array.from({length:count},(_,index)=>record(String(index+1),{text:messageText(index),sender:index%2?'owner':'contact',sentAt:String(1700000000000+index*60000)})),completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(contactId);
 const management=new SqliteMemoryManagement(f.storage,owner);
 const memory=await management.decide({requestKey:randomUUID(),action:'manual',scope:{scopeKind:'contact',contactId},body:'喜欢园艺和玫瑰。'});
 const discussion=await new SqliteDiscussionService(f.storage,owner).newDiscussion(contactId),requestKey=randomUUID();
 const confirmationId=await f.storage.execute('identity.manualConfirm',{ownerId:owner,contactId,contextToken:requestKey,id:randomUUID(),at:Date.now()});
 const {attempt}=await new SqliteReplyCandidateService(f.storage,owner).begin({contactId,discussionId:discussion.id,requestKey,text:'园艺',identity:{kind:'manual',confirmationId}});
 const scope={...attempt,contextId:randomUUID()};
 const db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'));t.after(()=>db.close());
 const all=(sql,values=[])=>{const statement=db.prepare(sql);statement.setReadBigInts(true);return statement.all(...values);};
 const tx={all,get:(sql,values)=>all(sql,values)[0],run:(sql,values=[])=>{db.prepare(sql).run(...values);}};
 const reader=createMemoryKnowledgeReader({includeUnconfirmed:false},assertReplyLocalSource);
 const first=initialFirst?tx.get('SELECT id FROM message WHERE owner_id=? AND contact_id=? ORDER BY display_no LIMIT 1',[owner,contactId]):null;
 const selected=first?await f.storage.execute('discussion.messages',{...attempt,messageIds:[first.id]}):[];
 await f.storage.execute('discussion.freezeContext',{...scope,skillRun:{packages:[],eligible:[]},items:selected.map(row=>({kind:'message',sourceContactId:contactId,messageId:row.id,recordId:row.record_id,acceptedRevision:row.interpretation_revision})),at:Date.now()});
 const action=createReplyKnowledgeStorageRegistry({migrations:[],actions:[{name:'test.search',mode:'write',retryBusy:false,execute:(tx,work)=>withReplyValidation(tx,work)}]},reader).actions[0];
 const act=work=>{db.exec('BEGIN IMMEDIATE');try{const value=action.execute(tx,work,f.storage.status);db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}};
 act(tx=>freezeReplyInput(tx,{...scope,workspace:{action:'suggest',draftText:'',instruction:'',contextText:'',tone:'warm',includeRelationshipContext:background,selectedPackageId:null,carriedSelectionId:null},at:Date.now()},reader));
 return {...f,scope,reader,act,db,tx,memory,management,initialMessageId:first?.id??null};
}

test('按需检索把冻结范围内L1与原始作者时间历史追加为可引用材料',async t=>{
 const f=await setup(t);f.act(tx=>initializeReplySearch(tx,f.scope,f.reader));
 const memoryTicket=f.act(tx=>beginReplySearch(tx,{...f.scope,kind:'memory',query:'玫瑰'},f.reader));
 const memories=f.act(tx=>finishReplySearch(tx,{...f.scope,ticketId:memoryTicket.ticketId,query:'玫瑰'},f.reader));
 assert.equal(memories.status,'ok');assert.equal(memories.items.length,1);assert.equal(memories.items[0].kind,'memory');assert.match(memories.items[0].text,/喜欢园艺和玫瑰/);assert.match(memories.items[0].text,/聊天时间未知/);
 const historyTicket=f.act(tx=>beginReplySearch(tx,{...f.scope,kind:'history',query:'园艺'},f.reader));
 const history=f.act(tx=>finishReplySearch(tx,{...f.scope,ticketId:historyTicket.ticketId,query:'园艺'},f.reader));
 assert.equal(history.status,'ok');assert.equal(history.items.length,2);assert.ok(history.items.every(item=>item.kind==='message'&&item.sources[0].contactId===f.scope.contactId));
 assert.match(history.items.find(item=>item.identity.senderRole==='owner').text,/（\d{4}-\d{2}-\d{2} \d{2}:\d{2}）我：园艺聊天2/);
 assert.match(history.items.find(item=>item.identity.senderRole==='contact').text,/对方：园艺聊天1/);
 assert.ok(history.items.every(item=>item.itemNo>memories.items[0].itemNo));assert.equal(history.scope,'frozen_contact_history');
});

test('历史搜索固定接纳边界而不复制消息ID，后入库及其他联系人消息不混入',async t=>{
 const f=await setup(t,{count:501,initialFirst:true});f.act(tx=>initializeReplySearch(tx,f.scope,f.reader));
 const scope=JSON.parse(f.tx.get("SELECT payload FROM execution_event WHERE owner_id=? AND kind='reply_search' AND json_extract(payload,'$.phase')='scope'",[owner]).payload);
 assert.equal(scope.version,2);assert.equal(scope.history,undefined,'范围元数据不保存逐条历史身份');
 assert.ok(scope.historyBoundary);assert.ok(JSON.stringify(scope).length<1000,'准备范围大小不随历史条数增长');
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('502',{text:'后来新增的航海正文'})],completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(f.scope.contactId);
 await f.service.synchronize(f.saved[1].contact_id);
 const ticket=f.act(tx=>beginReplySearch(tx,{...f.scope,kind:'history',query:'航海'},f.reader));
 assert.equal(f.act(tx=>finishReplySearch(tx,{...f.scope,ticketId:ticket.ticketId,query:'航海'},f.reader)).status,'empty');
 const inScope=f.act(tx=>beginReplySearch(tx,{...f.scope,kind:'history',query:'园艺'},f.reader));
 const result=f.act(tx=>finishReplySearch(tx,{...f.scope,ticketId:inScope.ticketId,query:'园艺'},f.reader));
 assert.ok(result.items.length>0&&result.items.every(item=>item.sources[0].contactId===f.scope.contactId));assert.ok(result.items.every(item=>item.sources[0].messageId!==f.initialMessageId),'已在初始输入中的消息不重复返回');
});

test('超过500条的当前联系人历史仍可命中早期约定，只向模型返回匹配结果',async t=>{
 const text='合成北极星约定：早年约好看流星雨。';
 const f=await setup(t,{count:1000,messageText:index=>index===0?text:`无关日常消息${index}`});
 f.act(tx=>initializeReplySearch(tx,f.scope,f.reader));
 const ticket=f.act(tx=>beginReplySearch(tx,{...f.scope,kind:'history',query:'北极星 流星雨'},f.reader));
 const result=f.act(tx=>finishReplySearch(tx,{...f.scope,ticketId:ticket.ticketId,query:ticket.query},f.reader));
 assert.equal(result.status,'ok');assert.equal(result.items.length,1);assert.ok(result.items[0].text.includes(text));
 assert.ok(result.items[0].sources.every(source=>source.contactId===f.scope.contactId));
});

test('删除后新消息复用接纳序号时，既有请求仍由真实删除围栏拒绝',async t=>{
 const f=await setup(t,{count:2});f.act(tx=>initializeReplySearch(tx,f.scope,f.reader));
 const old=f.tx.get(`SELECT m.display_no,r.id record_id FROM message m JOIN capture_record r ON r.owner_id=m.owner_id AND r.message_id=m.id
  WHERE m.owner_id=? AND m.contact_id=? ORDER BY m.display_no DESC LIMIT 1`,[owner,f.scope.contactId]);
 const deletion=new DeletionService(f.storage,f.service.holders,new ManagedFiles(f.root)),operation=await deletion.plan({ownerId:owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.scope.contactId,sourceId:old.record_id}});
 assert.equal((await deletion.advance(operation)).state,'completed');
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('3',{text:'后来新增的航海约定'})],completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(f.scope.contactId);
 const added=f.tx.get('SELECT display_no FROM message WHERE owner_id=? AND contact_id=? AND text_body=?',[owner,f.scope.contactId,'后来新增的航海约定']);
 assert.ok(added.display_no<=old.display_no,'夹具确实覆盖删除后序号复用');
 assert.throws(()=>f.act(tx=>beginReplySearch(tx,{...f.scope,kind:'history',query:'航海'},f.reader)),{code:'discussion_request_stale'});
});

test('来源失效先跳过未读取结果，已追加材料仍在下一轮资格复验时拒绝',async t=>{
 const f=await setup(t);f.act(tx=>initializeReplySearch(tx,f.scope,f.reader));
 const pending=f.act(tx=>beginReplySearch(tx,{...f.scope,kind:'history',query:'园艺'},f.reader));
 const unavailable=f.tx.get('SELECT id FROM capture_record WHERE owner_id=? AND contact_id=? ORDER BY id LIMIT 1',[owner,f.scope.contactId]);
 f.act(tx=>tx.run("UPDATE capture_record SET availability='deleting' WHERE owner_id=? AND id=?",[owner,unavailable.id]));
 const result=f.act(tx=>finishReplySearch(tx,{...f.scope,ticketId:pending.ticketId,query:'园艺'},f.reader));assert.equal(result.items.length,1);
 const source=result.items[0].sources[0];
 f.act(tx=>tx.run("UPDATE capture_record SET availability='deleting' WHERE owner_id=? AND id=?",[owner,source.recordId]));
 assert.throws(()=>f.act(tx=>requireReplyInput(tx,f.scope,f.scope.contextId,f.reader)),error=>['history_source_not_available','reply_source_unavailable'].includes(error.code));
});

test('Skill降级保留追加材料且查询次数与L1额度不重置',async t=>{
 const f=await setup(t);f.act(tx=>initializeReplySearch(tx,f.scope,f.reader));
 for(const [kind,query] of [['memory','玫瑰'],['history','园艺']]){
  const ticket=f.act(tx=>beginReplySearch(tx,{...f.scope,kind,query},f.reader));assert.equal(f.act(tx=>finishReplySearch(tx,{...f.scope,ticketId:ticket.ticketId,query},f.reader)).status,'ok');
 }
 const fallback=f.act(tx=>dropSkillContext(tx,f.scope,tx.get('SELECT * FROM reply_context WHERE owner_id=? AND id=?',[owner,f.scope.contextId]))),next={...f.scope,contextId:fallback.contextId};
 f.act(tx=>requireReplyInput(tx,next,next.contextId,f.reader));
 const copied=f.tx.all('SELECT kind FROM reply_candidate_input WHERE owner_id=? AND context_id=?',[owner,next.contextId]);assert.ok(copied.some(row=>row.kind==='memory'));assert.equal(copied.filter(row=>row.kind==='message').length,2);
 const third=f.act(tx=>beginReplySearch(tx,{...next,kind:'memory',query:'喜欢'},f.reader));assert.equal(third.status,'accepted');assert.equal(f.act(tx=>finishReplySearch(tx,{...next,ticketId:third.ticketId,query:'喜欢'},f.reader)).status,'empty');
 assert.equal(f.act(tx=>beginReplySearch(tx,{...next,kind:'history',query:'聊天'},f.reader)).code,'reply_search_budget_exceeded');
});

test('删除工具真实来源沿既有闭包清除追加材料并拒收晚到结果',async t=>{
 const f=await setup(t);f.act(tx=>initializeReplySearch(tx,f.scope,f.reader));
 const ticket=f.act(tx=>beginReplySearch(tx,{...f.scope,kind:'history',query:'园艺'},f.reader)),result=f.act(tx=>finishReplySearch(tx,{...f.scope,ticketId:ticket.ticketId,query:'园艺'},f.reader));
 const pending=f.act(tx=>beginReplySearch(tx,{...f.scope,kind:'memory',query:'玫瑰'},f.reader));
 const deletion=new DeletionService(f.storage,f.service.holders,new ManagedFiles(f.root)),operation=await deletion.plan({ownerId:owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.scope.contactId,sourceId:result.items[0].sources[0].recordId}});
 assert.equal((await deletion.advance(operation)).state,'completed');
 assert.equal(f.tx.get('SELECT count(*) n FROM reply_candidate_input WHERE owner_id=? AND context_id=?',[owner,f.scope.contextId]).n,0n);
 assert.throws(()=>f.act(tx=>finishReplySearch(tx,{...f.scope,ticketId:pending.ticketId,query:'玫瑰'},f.reader)));
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('手录L1真实删除域回调擦除从未返回的scope和begin锚点，不新增单条删除入口',async t=>{
 const f=await setup(t);f.act(tx=>initializeReplySearch(tx,f.scope,f.reader));
 const ticket=f.act(tx=>beginReplySearch(tx,{...f.scope,kind:'memory',query:'unmatched-volcano'},f.reader));
 assert.equal(f.act(tx=>finishReplySearch(tx,{...f.scope,ticketId:ticket.ticketId,query:ticket.query},f.reader)).status,'empty');
 const metadata=()=>f.tx.all("SELECT payload FROM execution_event WHERE owner_id=? AND kind='reply_search'",[owner]).map(row=>JSON.parse(row.payload));
 const textSeal=sha256('喜欢园艺和玫瑰。');assert.ok(JSON.stringify(metadata()).includes(textSeal));
 // 当前产品无单条手录记忆删除API；沿已存在contact删除计划调用真实memory清理回调。
 const deletion=new DeletionService(f.storage,f.service.holders,new ManagedFiles(f.root)),operation=await deletion.plan({ownerId:owner,requestKey:randomUUID(),scope:{kind:'contact',contactId:f.scope.contactId}});
 const target=operation.targets.find(row=>row.target?.domain==='memory_management'&&row.target?.rowKind==='memory'&&row.target?.key.id===f.memory.memoryId)?.target;
 assert.ok(target);f.act(tx=>memoryManagementDeletionDomain.clearRow(tx,operation,target));
 assert.equal(f.tx.get('SELECT id FROM memory WHERE owner_id=? AND id=?',[owner,f.memory.memoryId]),undefined);
 const retained=metadata(),wire=JSON.stringify(retained);assert.ok(!wire.includes(f.memory.memoryId));assert.ok(!wire.includes(textSeal));
 assert.equal(retained.filter(row=>row.phase==='begin').length,1);assert.equal(retained.filter(row=>row.phase==='finish'&&row.status==='empty').length,1,'清锚点不撤销已消费尝试和无正文回执');
 assert.equal((await deletion.advance(operation)).state,'completed');
});

test('冻结L1范围排除新记忆与修正版本，关闭背景和旧上下文不补造范围',async t=>{
 const f=await setup(t);
 assert.equal(f.act(tx=>beginReplySearch(tx,{...f.scope,kind:'memory',query:'园艺'},f.reader)).code,'reply_search_unavailable');
 f.act(tx=>initializeReplySearch(tx,f.scope,f.reader));
 await f.management.decide({requestKey:randomUUID(),action:'manual',scope:{scopeKind:'contact',contactId:f.scope.contactId},body:'后来新建的合成航海记忆。'});
 const later=f.act(tx=>beginReplySearch(tx,{...f.scope,kind:'memory',query:'航海'},f.reader));
 assert.equal(later.pool.length,1,'临时池只含初始化时已有的版本');
 assert.equal(f.act(tx=>finishReplySearch(tx,{...f.scope,ticketId:later.ticketId,query:'航海'},f.reader)).status,'empty');
 const before=f.act(tx=>beginReplySearch(tx,{...f.scope,kind:'memory',query:'玫瑰'},f.reader));
 const current=(await f.management.read({scopeKind:'contact',contactId:f.scope.contactId})).memories.find(item=>item.id===f.memory.memoryId);
 await f.management.decide({requestKey:randomUUID(),action:'correct',memoryId:current.id,expectedVersionNo:current.current.versionNo,expectedHeadRevision:current.headRevision,body:'修正后只喜欢合成航海。'});
 assert.equal(f.act(tx=>finishReplySearch(tx,{...f.scope,ticketId:before.ticketId,query:'玫瑰'},f.reader)).status,'empty');
 const closed=await setup(t,{background:false});closed.act(tx=>initializeReplySearch(tx,closed.scope,closed.reader));
 assert.equal(closed.act(tx=>beginReplySearch(tx,{...closed.scope,kind:'history',query:'园艺'},closed.reader)).code,'reply_search_unavailable');
});

test('空结果和执行失败占尝试，重复和400字符校验拒绝有无正文回执',async t=>{
 const f=await setup(t);f.act(tx=>initializeReplySearch(tx,f.scope,f.reader));
 const run=(kind,query,error)=>{const ticket=f.act(tx=>beginReplySearch(tx,{...f.scope,kind,query},f.reader));return ticket.status==='accepted'?f.act(tx=>finishReplySearch(tx,{...f.scope,ticketId:ticket.ticketId,query,error},f.reader)):ticket;};
 assert.equal(run('memory','合成无匹配火山').status,'empty');
 assert.equal(run('memory','合成无匹配火山').code,'reply_search_duplicate');
 assert.equal(run('history','🚀'.repeat(401)).code,'reply_search_query_invalid');
 assert.equal(run('history','🚀'.repeat(400)).status,'empty','字符按Unicode码点计数，400个补充平面字符仍合法');
 assert.equal(run('history','园艺','timeout').status,'error');
 assert.equal(run('memory','玫瑰').code,'reply_search_budget_exceeded');
 const receipts=f.tx.all("SELECT payload FROM execution_event WHERE owner_id=? AND kind='reply_search'",[owner]).map(row=>JSON.parse(row.payload));
 assert.equal(receipts.filter(row=>row.phase==='begin').length,3);assert.equal(receipts.filter(row=>row.phase==='rejected').length,3);
 const wire=JSON.stringify(receipts);assert.doesNotMatch(wire,/合成无匹配火山|园艺|玫瑰|喜欢|🚀/,'事件只记录摘要和身份元数据');
});

test('整轮L1按联系人5条本人3条去重，语义池以冻结ID版本限制',async t=>{
 const f=await setup(t);
 for(const [scope,count] of [[{scopeKind:'contact',contactId:f.scope.contactId},6],[{scopeKind:'self',contactId:null},4]])for(let index=0;index<count;index++)await f.management.decide({requestKey:randomUUID(),action:'manual',scope,body:`园艺玫瑰合成资料${index}。`});
 f.act(tx=>initializeReplySearch(tx,f.scope,f.reader));
 const first=f.act(tx=>beginReplySearch(tx,{...f.scope,kind:'memory',query:'园艺'},f.reader));
 const semantic={query:'园艺',scores:Object.fromEntries(first.pool.map(item=>[`${item.id}:${item.versionNo}`,1]))};
 semantic.scores['forged-id:1']=1;
 const result=f.act(tx=>finishReplySearch(tx,{...f.scope,ticketId:first.ticketId,query:'园艺',semantic},f.reader));
 assert.equal(result.items.filter(item=>item.identity.scopeKind==='contact').length,5);assert.equal(result.items.filter(item=>item.identity.scopeKind==='owner').length,3);assert.ok(result.items.every(item=>item.identity.id!=='forged-id'));
 const second=f.act(tx=>beginReplySearch(tx,{...f.scope,kind:'memory',query:'玫瑰'},f.reader));
 assert.equal(f.act(tx=>finishReplySearch(tx,{...f.scope,ticketId:second.ticketId,query:'玫瑰'},f.reader)).status,'empty','新关键词不重新获得5+3额度');
 assert.equal(f.act(tx=>finishReplySearch(tx,{...f.scope,ticketId:first.ticketId,query:'园艺'},f.reader)).code,'reply_search_ticket_finished');
});

test('历史累计最多16条且2048估算token，超长完整消息跳过',async t=>{
 const f=await setup(t,{count:40});f.act(tx=>initializeReplySearch(tx,f.scope,f.reader));
 const first=f.act(tx=>beginReplySearch(tx,{...f.scope,kind:'history',query:'园艺'},f.reader));
 const result=f.act(tx=>finishReplySearch(tx,{...f.scope,ticketId:first.ticketId,query:'园艺'},f.reader));assert.equal(result.items.length,16);
 const second=f.act(tx=>beginReplySearch(tx,{...f.scope,kind:'history',query:'聊天'},f.reader));
 assert.equal(f.act(tx=>finishReplySearch(tx,{...f.scope,ticketId:second.ticketId,query:'聊天'},f.reader)).status,'empty');
 const long=await setup(t,{count:3,messageText:index=>index===0?'园艺'+ '字'.repeat(1000):'园艺'+ '字'.repeat(400)});long.act(tx=>initializeReplySearch(tx,long.scope,long.reader));
 const ticket=long.act(tx=>beginReplySearch(tx,{...long.scope,kind:'history',query:'园艺'},long.reader)),limited=long.act(tx=>finishReplySearch(tx,{...long.scope,ticketId:ticket.ticketId,query:'园艺'},long.reader));
 assert.equal(limited.items.length,1);assert.match(limited.items[0].text,new RegExp('字'.repeat(400)+'$'));assert.ok(Buffer.byteLength(limited.items[0].text,'utf8')<=2048);
});

test('全历史排序保留能填入剩余预算的较低分短消息，不截断候选集',async t=>{
 const f=await setup(t,{count:40,messageText:index=>index<39?'园艺玫瑰'+'字'.repeat(600):'园艺'});
 f.act(tx=>initializeReplySearch(tx,f.scope,f.reader));
 const ticket=f.act(tx=>beginReplySearch(tx,{...f.scope,kind:'history',query:'园艺 玫瑰'},f.reader));
 const result=f.act(tx=>finishReplySearch(tx,{...f.scope,ticketId:ticket.ticketId,query:ticket.query},f.reader));
 assert.equal(result.items.length,2);assert.ok(result.items.some(item=>item.text.endsWith('：园艺')));
 assert.ok(result.items.reduce((sum,item)=>sum+Buffer.byteLength(item.text,'utf8'),0)<=2048);
});

test('历史搜索超时返回未完成回执，不追加部分结果，已消费尝试保留',async t=>{
 const f=await setup(t,{count:10});f.act(tx=>initializeReplySearch(tx,f.scope,f.reader));
 const ticket=f.act(tx=>beginReplySearch(tx,{...f.scope,kind:'history',query:'园艺'},f.reader));let elapsed=0;
 const result=f.act(tx=>finishReplySearch(tx,{...f.scope,ticketId:ticket.ticketId,query:ticket.query},f.reader,{clock:()=>elapsed+=2000}));
 assert.equal(result.status,'error');assert.equal(result.code,'reply_search_timeout');assert.deepEqual(result.items,[]);
 assert.equal(f.tx.get("SELECT count(*) n FROM reply_candidate_input WHERE owner_id=? AND context_id=? AND kind='message'",[owner,f.scope.contextId]).n,0n);
 const receipts=f.tx.all("SELECT payload FROM execution_event WHERE owner_id=? AND kind='reply_search'",[owner]).map(row=>JSON.parse(row.payload));
 assert.equal(receipts.filter(row=>row.phase==='begin').length,1);assert.ok(receipts.some(row=>row.phase==='finish'&&row.status==='error'&&row.code==='timeout'));
});

for(const count of [10,100,1000])test(`全部历史有${count}条时分页搜索，实际返回来源不超过16条`,async t=>{
 const f=await setup(t,{count});let queries=0,sourceQueries=0;
 const counted={...f.tx,get(sql,values){queries++;if(sql.includes('wanted AS ('))sourceQueries++;return f.tx.get(sql,values);},all(sql,values){queries++;if(sql.includes('wanted AS ('))sourceQueries++;return f.tx.all(sql,values);}};
 f.act(()=>withReplyValidation(counted,tx=>initializeReplySearch(tx,f.scope,f.reader)));const initializeQueries=queries,initializeSourceQueries=sourceQueries;
 const ticket=f.act(tx=>beginReplySearch(tx,{...f.scope,kind:'history',query:'园艺'},f.reader));queries=0;sourceQueries=0;
 const result=f.act(()=>withReplyValidation(counted,tx=>finishReplySearch(tx,{...f.scope,ticketId:ticket.ticketId,query:'园艺'},f.reader)));
 assert.equal(result.items.length,Math.min(count,16));assert.equal(initializeSourceQueries,0,'初始化只记录接纳边界，不逐条打开来源');assert.ok(initializeQueries<=40,`准备查询不随历史条数逐条增长：${initializeQueries}`);assert.ok(sourceQueries<=17,`只核实际返回来源：${sourceQueries}`);
 t.diagnostic(JSON.stringify({historyCount:count,initializeQueries,finishQueries:queries,sourceQueries,returned:result.items.length}));
});
