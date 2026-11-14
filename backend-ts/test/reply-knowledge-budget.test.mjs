import test from 'node:test';
import assert from 'node:assert/strict';
import {selectReplyKnowledge} from '../src/reply/sqlite/candidates/knowledge-budget.ts';

function memory(id,scopeKind='contact',kind='memory',text='园艺完整资料。'){
 return {id,kind,scopeKind,text,versionNo:1n,contactId:scopeKind==='contact'?'synthetic-contact':null,publicationId:null,qualification:kind==='memory_candidate'?'unconfirmed':'confirmed',sources:[]};
}

test('未确认候选独立限额跨本人和联系人合计三条，不挤占确认记忆预算',()=>{
 const contacts=Array.from({length:6},(_,n)=>memory(`contact-${n}`));
 const owners=Array.from({length:4},(_,n)=>memory(`owner-${n}`,'owner'));
 const candidates=Array.from({length:5},(_,n)=>memory(`candidate-${n}`,n%2?'owner':'contact','memory_candidate'));
 const selected=selectReplyKnowledge([...candidates,...owners,...contacts],'园艺');
 assert.deepEqual(selected.filter(item=>item.kind==='memory'&&item.scopeKind==='contact'),contacts.slice(0,5));
 assert.deepEqual(selected.filter(item=>item.kind==='memory'&&item.scopeKind==='owner'),owners.slice(0,3));
 assert.deepEqual(selected.filter(item=>item.kind==='memory_candidate'),candidates.slice(0,3));
 for(const item of selected.filter(item=>item.kind==='memory_candidate'))assert.equal(item.qualification,'unconfirmed');
});

test('未确认候选字符预算独立累计300个Unicode字符，保留完整条目并跳过放不下的条目',()=>{
 const body=size=>'园艺'+'𠀀'.repeat(size-2);
 const candidates=[memory('candidate-a','contact','memory_candidate',body(301)),memory('candidate-b','owner','memory_candidate',body(151)),memory('candidate-c','contact','memory_candidate',body(151)),memory('candidate-d','contact','memory_candidate',body(149))];
 const contact=memory('contact','contact','memory',body(600)),owner=memory('owner','owner','memory',body(240));
 const selected=selectReplyKnowledge([...candidates,contact,owner],'园艺');
 assert.deepEqual(selected.filter(item=>item.kind==='memory_candidate'),[candidates[1],candidates[3]]);
 assert.equal(selected.includes(contact),true);assert.equal(selected.includes(owner),true);
 assert.equal(selected.filter(item=>item.kind==='memory_candidate').reduce((sum,item)=>sum+Array.from(item.text).length,0),300);
});

test('未确认候选沿用词法阈值，空查询和不相关资料不会进入任何记忆预算',()=>{
 const candidates=[memory('candidate-a','contact','memory_candidate','园艺完整资料。'),memory('candidate-b','owner','memory_candidate','星际天文完整资料。')];
 assert.deepEqual(selectReplyKnowledge(candidates,''),[]);
 assert.deepEqual(selectReplyKnowledge(candidates,'园艺'),[candidates[0]]);
 assert.deepEqual(selectReplyKnowledge(candidates,'羽毛球'),[]);
});

test('相关性相同时人工确认记忆优先，不因稳定ID排序被自动记忆挤出预算',()=>{
 for(const scopeKind of ['contact','owner']){
  const automatic=Array.from({length:6},(_,index)=>({...memory(`automatic-${index}`,scopeKind),qualification:'auto'}));
  const confirmed=memory('z-confirmed',scopeKind);
  const selected=selectReplyKnowledge([...automatic,confirmed],'园艺');
  assert.equal(selected[0],confirmed,`${scopeKind}须在同分资料中优先使用人工确认记忆`);
  assert.equal(selected.length,scopeKind==='contact'?5:3);
 }
});

test('联系人与本人记忆不设字符上限，只受条数上限约束并保留完整正文',()=>{
 const long=size=>'园艺'+'𠀀'.repeat(size-2);
 const contacts=Array.from({length:6},(_,n)=>memory(`contact-${n}`,'contact','memory',long(700)));
 const owners=Array.from({length:4},(_,n)=>memory(`owner-${n}`,'owner','memory',long(300)));
 const selected=selectReplyKnowledge([...contacts,...owners],'园艺');
 assert.deepEqual(selected.filter(item=>item.scopeKind==='contact'),contacts.slice(0,5));
 assert.deepEqual(selected.filter(item=>item.scopeKind==='owner'),owners.slice(0,3));
 for(const item of selected)assert.equal(Array.from(item.text).length,item.scopeKind==='contact'?700:300);
});

test('较长记忆不再挤掉后面的相关记忆',()=>{
 const long=memory('contact-long','contact','memory','园艺'+'𠀀'.repeat(900));
 const short=memory('contact-short','contact','memory','园艺短资料');
 const selected=selectReplyKnowledge([long,short],'园艺');
 assert.equal(selected.includes(long),true);assert.equal(selected.includes(short),true);
});

test('工作区检索词：帮我表达以草稿为准，最新优先的消息只取前5条原文',async()=>{
 const {workspaceRetrievalQuery}=await import('../src/reply/sqlite/candidates/input.ts');
 const bodies=['最新一条','次新一条','第三新','第四新','第五新','旧话题甲','旧话题乙'];
 assert.equal(workspaceRetrievalQuery({action:'express',draftText:'我想请假'},bodies),'我想请假');
 assert.equal(workspaceRetrievalQuery({action:'express',draftText:'  '},bodies),'最新一条\n次新一条\n第三新\n第四新\n第五新');
 assert.equal(workspaceRetrievalQuery({action:'suggest',draftText:'我想请假'},bodies),'最新一条\n次新一条\n第三新\n第四新\n第五新');
 assert.equal(workspaceRetrievalQuery({action:'suggest',draftText:''},['只有一条']),'只有一条');
 assert.equal(workspaceRetrievalQuery({action:'suggest',draftText:''},[]),'');
});

test('混合检索：语义为主的综合分入选，词法只加少量分，词法命中但语义很低的不入选',async()=>{
 const {semanticKey}=await import('../src/reply/sqlite/candidates/memory-semantics.ts');
 const hike=memory('hike','contact','memory','他喜欢爬山。'),boosted=memory('boosted','contact','memory','徒步装备已经买好。'),plain=memory('plain','contact','memory','公司报销流程复杂。'),lexicalOnly=memory('lex','contact','memory','徒步徒步徒步。');
 const semantic=new Map([[semanticKey('hike',1n),0.72],[semanticKey('boosted',1n),0.55],[semanticKey('plain',1n),0.55],[semanticKey('lex',1n),0.2]]);
 // hike 仅凭语义 0.72×0.8 入选；boosted 与 plain 语义同为 0.55（0.44），只有词法命中的 boosted 加分后越过 0.48；lex 词法命中但语义仅 0.2，综合分不足。
 const selected=selectReplyKnowledge([plain,lexicalOnly,boosted,hike],'想去徒步',semantic);
 assert.deepEqual(selected.map(item=>item.id),['hike','boosted']);
 assert.deepEqual(selectReplyKnowledge([plain,lexicalOnly,boosted,hike],'想去徒步').map(item=>item.id).sort(),['boosted','lex']);
});

test('混合检索：综合分门槛为 0.48（语义 0.8＋词法 0.2），缺少语义得分或为候选的资料不入选',async()=>{
 const {semanticKey,HYBRID_THRESHOLD,DENSE_WEIGHT,SPARSE_WEIGHT}=await import('../src/reply/sqlite/candidates/memory-semantics.ts');
 assert.equal(HYBRID_THRESHOLD,0.48);assert.equal(DENSE_WEIGHT,0.8);assert.equal(SPARSE_WEIGHT,0.2);
 const items=[memory('below'),memory('at'),memory('missing'),memory('candidate','contact','memory_candidate')].map((item,n)=>({...item,text:`无关文字${n}。`}));
 const semantic=new Map([[semanticKey('below',1n),0.59],[semanticKey('at',1n),0.61],[semanticKey('candidate',1n),0.99]]);
 assert.deepEqual(selectReplyKnowledge(items,'完全不同的查询',semantic).map(item=>item.id),['at']);
});

test('混合检索仍受条数上限约束，且不设字符上限',async()=>{
 const {semanticKey}=await import('../src/reply/sqlite/candidates/memory-semantics.ts');
 const long=n=>'𠀀'.repeat(900)+n;
 const contacts=Array.from({length:7},(_,n)=>memory(`c${n}`,'contact','memory',long(n))),owners=Array.from({length:5},(_,n)=>memory(`o${n}`,'owner','memory',long(n)));
 const semantic=new Map([...contacts,...owners].map((item,n)=>[semanticKey(item.id,1n),0.9-n*0.01]));
 const selected=selectReplyKnowledge([...contacts,...owners],'毫无词法重合',semantic);
 assert.equal(selected.filter(item=>item.scopeKind==='contact').length,5);assert.equal(selected.filter(item=>item.scopeKind==='owner').length,3);
 assert.deepEqual(selected.filter(item=>item.scopeKind==='contact').map(item=>item.id),['c0','c1','c2','c3','c4']);
});

test('语义得分：事务外按余弦计算，模型失败返回 null，检索词不一致时被忽略',async()=>{
 const {scoreMemorySemantics,readSemanticScores,semanticKey}=await import('../src/reply/sqlite/candidates/memory-semantics.ts');
 const embed=async texts=>texts.map(text=>text.includes('徒步')||text.includes('爬山')?[1,0]:[0,1]);
 const pool=[{id:'a',versionNo:'1',text:'他喜欢爬山'},{id:'b',versionNo:'2',text:'报销流程'}];
 const scored=await scoreMemorySemantics('想去徒步',pool,embed);
 assert.equal(scored.query,'想去徒步');assert.equal(scored.scores[semanticKey('a','1')],1);assert.equal(scored.scores[semanticKey('b','2')],0);
 assert.equal(await scoreMemorySemantics('想去徒步',pool,async()=>{throw new Error('模型不可用');}),null);
 assert.equal(await scoreMemorySemantics('想去徒步',pool,async texts=>texts.map(()=>[Number.NaN,1])),null);
 assert.equal(await scoreMemorySemantics('  ',pool,embed),null);assert.equal(await scoreMemorySemantics('想去徒步',[],embed),null);
 assert.equal(readSemanticScores(scored,'另一个查询'),undefined);
 assert.equal(readSemanticScores({query:'想去徒步',scores:{a:'x'}},'想去徒步'),undefined);
 assert.equal(readSemanticScores(scored,'想去徒步').get(semanticKey('a','1')),1);
});

// 按需核验：排序只看正文，入选前才核验；失效条目被跳过且不占预算，也不扩大核验范围。
function lazySource(items,{stale=new Set()}={}){
 const opened=[];
 return {opened,source:{memories:items,documents:[],open(header){opened.push(header.id);return stale.has(header.id)?null:header;}}};
}

test('按需核验：只核验可能入选的条目，结果与整体读取一致',()=>{
 const contacts=Array.from({length:50},(_,n)=>memory(`contact-${String(n).padStart(2,'0')}`));
 const {source,opened}=lazySource(contacts);
 assert.deepEqual(selectReplyKnowledge(source,'园艺'),selectReplyKnowledge(contacts,'园艺'));
 assert.deepEqual(opened,contacts.slice(0,5).map(item=>item.id),'50 条同分记忆只核验预算内的 5 条');
});

test('按需核验：失效条目被跳过，由排在后面的条目补位，且失效条目不占条数预算',()=>{
 const contacts=Array.from({length:8},(_,n)=>memory(`contact-${n}`));
 const {source,opened}=lazySource(contacts,{stale:new Set(['contact-1','contact-3'])});
 const selected=selectReplyKnowledge(source,'园艺');
 assert.deepEqual(selected.map(item=>item.id),['contact-0','contact-2','contact-4','contact-5','contact-6']);
 assert.deepEqual(opened,['contact-0','contact-1','contact-2','contact-3','contact-4','contact-5','contact-6']);
});

test('按需核验：字符预算放不下的条目不核验，空查询与无关资料不核验任何条目',()=>{
 const body=size=>'园艺'+'𠀀'.repeat(size-2);
 const candidates=[memory('candidate-a','contact','memory_candidate',body(301)),memory('candidate-b','owner','memory_candidate',body(151))];
 const {source,opened}=lazySource(candidates);
 assert.deepEqual(selectReplyKnowledge(source,'园艺').map(item=>item.id),['candidate-b']);
 assert.deepEqual(opened,['candidate-b'],'超出 300 字符预算的候选无需核验');
 const idle=lazySource([memory('contact-x')]);
 assert.deepEqual(selectReplyKnowledge(idle.source,''),[]);assert.deepEqual(selectReplyKnowledge(idle.source,'完全无关的话题'),[]);
 assert.deepEqual(idle.opened,[]);
});
