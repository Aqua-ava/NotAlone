import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {fixture,owner,record} from './fixtures/memory-sqlite/support.mjs';
import {SqliteDiscussionService} from '../src/reply/sqlite/service.ts';
import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';
import {createReplyLocalKnowledgeReader} from '../src/memory/sqlite/documents/knowledge.ts';
import {initializeReplySearch,beginReplySearch,finishReplySearch} from '../src/reply/sqlite/candidates/search.ts';
import {freezeReplyInput,requireReplyInput} from '../src/reply/sqlite/candidates/input.ts';
import {withReplyValidation} from '../src/reply/sqlite/candidates/validation.ts';
import {createReplyKnowledgeStorageRegistry} from '../src/reply/sqlite/candidates/knowledge-context.ts';
import {configureRetrievalConnection} from '../src/retrieval/sqlite/extension.ts';
import {DeletionService} from '../src/storage/sqlite/deletion/service.ts';
import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';
import {decode,encode} from '../src/reply/sqlite/requests.ts';

const epoch=1700000000000;
const at=(n,text,extra={})=>record(String(n),{text,sentAt:String(epoch+n*1000),...extra});
async function setup(t,records,{initialTexts=[]}={}){
 const f=await fixture(t),contactId=f.saved[0].contact_id;
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records,completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(contactId);
 const discussion=await new SqliteDiscussionService(f.storage,owner).newDiscussion(contactId),requestKey=randomUUID();
 const confirmationId=await f.storage.execute('identity.manualConfirm',{ownerId:owner,contactId,contextToken:requestKey,id:randomUUID(),at:Date.now()});
 const {attempt}=await new SqliteReplyCandidateService(f.storage,owner).begin({contactId,discussionId:discussion.id,requestKey,text:'依据历史资料拟回复',identity:{kind:'manual',confirmationId}});
 const scope={...attempt,contextId:randomUUID()},db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'),{allowExtension:true});
 const index=configureRetrievalConnection(db);t.after(()=>db.close());
 const all=(sql,values=[])=>{const statement=db.prepare(sql);statement.setReadBigInts(true);return statement.all(...values);};
 const tx={all,get:(sql,values)=>all(sql,values)[0],run:(sql,values=[])=>{db.prepare(sql).run(...values);}};
 const reader=createReplyLocalKnowledgeReader();
 const ids=initialTexts.map(text=>tx.get('SELECT id FROM message WHERE owner_id=? AND contact_id=? AND text_body=?',[owner,contactId,text]).id);
 const selected=ids.length?await f.storage.execute('discussion.messages',{...attempt,messageIds:ids}):[];
 await f.storage.execute('discussion.freezeContext',{...scope,skillRun:{packages:[],eligible:[]},items:selected.map(row=>({kind:'message',sourceContactId:contactId,messageId:row.id,recordId:row.record_id,acceptedRevision:row.interpretation_revision})),at:Date.now()});
 const action=createReplyKnowledgeStorageRegistry({migrations:[],actions:[{name:'test.context',mode:'write',retryBusy:false,execute:(tx,work)=>withReplyValidation(tx,work)}]},reader).actions[0];
 const act=work=>{index?.begin();db.exec('BEGIN IMMEDIATE');try{const value=action.execute(tx,work,f.storage.status);index?.flush();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}};
 act(tx=>freezeReplyInput(tx,{...scope,workspace:{action:'suggest',draftText:'',contextText:'',includeRelationshipContext:true,selectedPackageId:null,carriedSelectionId:null},at:Date.now()},reader));
 act(tx=>initializeReplySearch(tx,scope,reader));
 const search=(query,options={})=>{const ticket=act(tx=>beginReplySearch(tx,{...scope,kind:'history',query},reader));assert.equal(ticket.status,'accepted');return act(tx=>finishReplySearch(tx,{...scope,ticketId:ticket.ticketId,query},reader,options));};
 return {...f,scope,tx,db,act,reader,search};
}

test('历史命中比例要求时，邻近纠正对象的原话也作为独立真实材料返回',async t=>{
 const f=await setup(t,[at(1,'课程签到暂时不查。'),at(5000,'我们说的是实验室工位时间。'),at(5001,'出勤比例不得低于80%。'),at(5002,'导师会看大家是否坐在工位。')]);
 const result=f.search('出勤比例');
 assert.equal(result.status,'ok');
 const anchor=result.items.find(item=>item.text.includes('出勤比例不得低于80%'));
 const context=result.items.find(item=>item.text.includes('我们说的是实验室工位时间'));
 assert.ok(anchor);assert.ok(context,'限定出勤对象的前话必须实际返回，不能只给无主语的比例');
 assert.equal(anchor.identity.evidenceRole,'match');assert.equal(context.identity.evidenceRole,'context');
 assert.equal(context.identity.evidenceGroup,anchor.identity.evidenceGroup);assert.equal(context.identity.contextOf,undefined);assert.equal(context.identity.contextPosition,'before');
 assert.equal(context.sources.length,1);assert.equal(context.sources[0].contactId,f.scope.contactId);
 assert.notEqual(context.itemNo,anchor.itemNo);assert.notEqual(context.sources[0].messageId,anchor.sources[0].messageId);
 assert.ok(!result.items.some(item=>item.text.includes('课程签到暂时不查')),'几千秒之外的另一话题不是相邻语境');
 f.act(tx=>requireReplyInput(tx,f.scope,f.scope.contextId,f.reader));
});

test('优先为最高命中返回连贯的有界片段，第六条后的对象限定不被其他组碎片挤掉',async t=>{
 const records=[
  at(1,'另一段课堂讨论的前话。'),at(2,'课堂里的出勤比例只是一个举例概念，不是另一件事的要求。'),at(3,'另一段课堂讨论的后话。'),
  at(4998,'实验安排还有一件事。'),at(4999,'这件事要注意一下。'),at(5000,'出勤比例80%。'),
  ...Array.from({length:5},(_,n)=>at(5001+n,`继续补充这件事的说明${n+1}。`)),
  at(5006,'这里要求的是实验室工位的在场时间，不是课堂签到。'),
  at(9999,'第三段交流的前话。'),at(10000,'出勤比例在第三段交流中也只是随口提及的概念说明。'),at(10001,'第三段交流的后话。'),
 ];
 const f=await setup(t,records),result=f.search('出勤比例');
 const primary=result.items.find(item=>item.identity.evidenceRole==='match'&&item.text.endsWith('出勤比例80%。'));
 assert.ok(primary);assert.equal(primary.identity.evidenceGroup,1,'短而直接的相关命中应优先');
 const qualifier=result.items.find(item=>item.text.includes('这里要求的是实验室工位的在场时间'));
 assert.ok(qualifier,'第六条后的主语限定须在最高命中的有界片段中实际载入');
 assert.equal(qualifier.identity.evidenceRole,'context');assert.equal(qualifier.identity.evidenceGroup,primary.identity.evidenceGroup);
 assert.ok(result.items.length<=16);assert.ok(result.items.reduce((sum,item)=>sum+Buffer.byteLength(item.text,'utf8'),0)<=2048);
});

test('邻近身份仍限定当前联系人和冻结接纳范围，已在初始材料中的原话不重复返回',async t=>{
 const initial='已经提供的限定语境。';
 const f=await setup(t,[at(1,initial),at(2,'出勤比例按校内规定执行。'),at(3,'另一条合法限定语境。')],{initialTexts:[initial]});
 await f.service.synchronize(f.saved[1].contact_id);
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[at(99,'后来补录的语境不应混入。',{sentAt:String(epoch+2500)})],completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(f.scope.contactId);
 const result=f.search('出勤比例');
 assert.ok(result.items.some(item=>item.identity.evidenceRole==='context'));
 assert.ok(result.items.every(item=>item.sources.every(source=>source.contactId===f.scope.contactId)));
 assert.ok(!result.items.some(item=>item.text.includes(initial)||item.text.includes('后来补录')));
});

test('来源已失效的邻近原话不读取为结果，返回材料仍保留其他合法语境',async t=>{
 const f=await setup(t,[at(1,'已经失效的限定语境。'),at(2,'出勤比例按校内规定执行。'),at(3,'仍然合法的后续原话。')]);
 const row=f.tx.get(`SELECT r.id FROM capture_record r JOIN message m ON m.owner_id=r.owner_id AND m.id=r.message_id WHERE m.owner_id=? AND m.contact_id=? AND m.text_body=?`,[owner,f.scope.contactId,'已经失效的限定语境。']);
 f.act(tx=>tx.run("UPDATE capture_record SET availability='deleting' WHERE owner_id=? AND id=?",[owner,row.id]));
 const result=f.search('出勤比例');
 assert.ok(!result.items.some(item=>item.text.includes('已经失效')));
 assert.ok(result.items.some(item=>item.text.includes('仍然合法')));
});

test('隔离中的邻近消息不因时间接近重新进入实际材料',async t=>{
 const f=await setup(t,[at(1,'已被隔离的限定原话。'),at(2,'出勤比例需要核对。'),at(3,'合法后续原话。')]);
 const row=f.tx.get('SELECT id FROM message WHERE owner_id=? AND contact_id=? AND text_body=?',[owner,f.scope.contactId,'已被隔离的限定原话。']);
 f.act(tx=>tx.run('INSERT INTO history_message_quarantine VALUES(?,?,?,?)',[owner,f.scope.contactId,row.id,'synthetic-isolation']));
 const result=f.search('出勤比例');
 assert.ok(!result.items.some(item=>item.text.includes('已被隔离')));
 assert.ok(result.items.some(item=>item.text.includes('合法后续')));
});

test('命中与邻近原话跨多次搜索共用十六条和完整UTF8正文预算',async t=>{
 const records=Array.from({length:30},(_,n)=>at(n+1,n%2?'出勤比例应按公开要求核对。':'同一段交流的限定原话，不冒充另一件事。'));
 const f=await setup(t,records),first=f.search('出勤比例'),second=f.search('比例要求');
 const items=[...first.items,...second.items],ids=items.map(item=>item.identity.messageId);
 assert.ok(first.items.some(item=>item.identity.evidenceRole==='context'));
 assert.ok(items.length<=16);assert.equal(new Set(ids).size,ids.length);
 assert.ok(items.reduce((sum,item)=>sum+Buffer.byteLength(item.text,'utf8'),0)<=2048);
 assert.ok(items.every(item=>/：.+[。]$/.test(item.text)),'不截断原话来凑预算');
});

test('未知时间不扩展，同时间语境明确保持顺序未核验',async t=>{
 const unknown=await setup(t,[at(1,'出勤比例时间未知。',{sentAt:null,timePrecision:null}),at(2,'不能猜它的前后文。')]);
 const unknownResult=unknown.search('出勤比例');
 assert.equal(unknownResult.items.length,1);assert.equal(unknownResult.items[0].identity.evidenceRole,'match');
 const equal=await setup(t,[at(1,'这是同一时间段的限定原话。',{sentAt:String(epoch)}),at(2,'出勤比例需要核对。',{sentAt:String(epoch)})]);
 const equalResult=equal.search('出勤比例');
 assert.equal(equalResult.items.find(item=>item.identity.evidenceRole==='context').identity.contextPosition,'same_time');
});

test('没有可靠邻近语境时仍可接纳剩余合法命中，三个优先占位不是新数量上限',async t=>{
 const f=await setup(t,Array.from({length:20},(_,n)=>at(n+1,`出勤比例规则${n}。`,{sentAt:null,timePrecision:null})));
 const result=f.search('出勤比例');
 assert.equal(result.items.length,16);assert.ok(result.items.every(item=>item.identity.evidenceRole==='match'));
 assert.equal(new Set(result.items.map(item=>item.identity.evidenceGroup)).size,16);
});

test('旧v1冻结身份集合不自动扩展成邻近读取',async t=>{
 const f=await setup(t,[at(1,'不应扩展的前话。'),at(2,'出勤比例需要核对。'),at(3,'不应扩展的后话。')]);
 f.act(tx=>{
  const event=tx.get("SELECT id,payload FROM execution_event WHERE owner_id=? AND reply_attempt_id=? AND kind='reply_search' AND json_extract(payload,'$.phase')='scope'",[owner,f.scope.attemptId]);
  const scope=decode(event.payload);scope.version=1;delete scope.historyBoundary;
  scope.history=tx.all(`SELECT m.id,m.interpretation_revision acceptedRevision,m.sender_role senderRole,m.sent_at sentAt,r.id recordId FROM message m JOIN capture_record r ON r.owner_id=m.owner_id AND r.message_id=m.id WHERE m.owner_id=? AND m.contact_id=?`,[owner,f.scope.contactId]);
  tx.run('UPDATE execution_event SET payload=? WHERE owner_id=? AND id=?',[encode(scope),owner,event.id]);
 });
 const result=f.search('出勤比例');assert.equal(result.items.length,1);assert.equal(result.items[0].identity.evidenceRole,'match');
});

test('邻近语境的来源参与后续实际输入核验，失效后拒绝整个旧输入',async t=>{
 const f=await setup(t,[at(1,'实验室工位的限定原话。'),at(2,'出勤比例需要核对。')]);
 const result=f.search('出勤比例'),context=result.items.find(item=>item.identity.evidenceRole==='context');assert.ok(context);
 f.act(tx=>tx.run("UPDATE capture_record SET availability='deleting' WHERE owner_id=? AND id=?",[owner,context.sources[0].recordId]));
 assert.throws(()=>f.act(tx=>requireReplyInput(tx,f.scope,f.scope.contextId,f.reader)),error=>['history_source_not_available','reply_source_unavailable'].includes(error.code));
});

test('删除邻近语境的真实来源沿既有删除闭包清除输入与晚到资格',async t=>{
 const f=await setup(t,[at(1,'实验室工位的限定原话。'),at(2,'出勤比例需要核对。')]);
 const result=f.search('出勤比例'),context=result.items.find(item=>item.identity.evidenceRole==='context');assert.ok(context);
 const deletion=new DeletionService(f.storage,f.service.holders,new ManagedFiles(f.root));
 const operation=await deletion.plan({ownerId:owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.scope.contactId,sourceId:context.sources[0].recordId}});
 assert.equal((await deletion.advance(operation)).state,'completed');
 assert.equal(f.tx.get('SELECT count(*) n FROM reply_candidate_input WHERE owner_id=? AND context_id=?',[owner,f.scope.contextId]).n,0n);
 assert.throws(()=>f.act(tx=>requireReplyInput(tx,f.scope,f.scope.contextId,f.reader)));
});

test('邻近语境物化期间超时仍原子回滚，不向输入追加部分结果',async t=>{
 const f=await setup(t,[at(1,'实验室工位的限定原话。'),at(2,'出勤比例需要核对。')]);
 let ticks=0;const result=f.search('出勤比例',{clock:()=>ticks+=1000});
 assert.equal(result.code,'reply_search_timeout');assert.deepEqual(result.items,[]);
 assert.equal(f.tx.get("SELECT count(*) n FROM reply_candidate_input WHERE owner_id=? AND context_id=? AND kind='message'",[owner,f.scope.contextId]).n,0n);
});
