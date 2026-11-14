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

test('正式记忆服从检索锚点的全局顺序，不按词法、分数或确认方式重排',()=>{
 const contact={...memory('contact','contact','memory','他喜欢爬山。'),qualification:'auto'},owner=memory('owner','owner','memory','公司报销流程复杂。'),other=memory('other','contact','memory','徒步装备已经买好。');
 const ranked=[{id:owner.id,versionNo:1n,score:0},{id:contact.id,versionNo:1n,score:0.01},{id:other.id,versionNo:1n,score:1}];
 assert.deepEqual(selectReplyKnowledge([contact,other,owner],'徒步',ranked),[owner,contact,other]);
 assert.deepEqual(selectReplyKnowledge([contact,other,owner],'',ranked),[owner,contact,other],'词法查询为空不改变已完成的检索排序');
});

test('正式记忆只选精确ID和版本锚点，未列出、过期、未知或候选锚点均不获得准入',()=>{
 const current={...memory('current'),versionNo:2n},unlisted=memory('unlisted'),candidate=memory('candidate','contact','memory_candidate','星际资料。');
 const ranked=[{id:'missing',versionNo:1n,score:1},{id:current.id,versionNo:1n,score:1},{id:candidate.id,versionNo:1n,score:1}];
 const {source,opened}=lazySource([unlisted,candidate,current]);
 assert.deepEqual(selectReplyKnowledge(source,'园艺',ranked),[]);
 assert.deepEqual(opened,[],'不合锚点的正文不进入来源核验');
 assert.deepEqual(selectReplyKnowledge(source,'园艺',[...ranked,{id:current.id,versionNo:2n,score:0}]),[current]);
 assert.deepEqual(selectReplyKnowledge([current,unlisted],'园艺',[]),[],'空检索结果不回退到词法准入');
});

test('检索锚点仍按联系人五条本人三条独立限额，完整长记忆不挤占候选词法预算',()=>{
 const contacts=Array.from({length:7},(_,n)=>memory(`c${n}`,'contact','memory','𠀀'.repeat(900)+n)),owners=Array.from({length:5},(_,n)=>memory(`o${n}`,'owner','memory','𠀀'.repeat(500)+n));
 const candidates=Array.from({length:5},(_,n)=>memory(`candidate-${n}`,n%2?'owner':'contact','memory_candidate','园艺'+'𠀀'.repeat(98)));
 const ranked=Array.from({length:7},(_,n)=>[contacts[n],owners[n]].filter(Boolean)).flat().map(item=>({id:item.id,versionNo:item.versionNo,score:0.01}));
 const selected=selectReplyKnowledge([...candidates,...owners,...contacts],'园艺',ranked);
 assert.deepEqual(selected.filter(item=>item.kind==='memory'&&item.scopeKind==='contact'),contacts.slice(0,5));
 assert.deepEqual(selected.filter(item=>item.kind==='memory'&&item.scopeKind==='owner'),owners.slice(0,3));
 assert.deepEqual(selected.filter(item=>item.kind==='memory_candidate'),candidates.slice(0,3));
 assert.ok(selected.filter(item=>item.kind==='memory').every(item=>Array.from(item.text).length===(item.scopeKind==='contact'?901:501)));
 assert.deepEqual(selectReplyKnowledge(candidates,'园艺',[]),candidates.slice(0,3),'未确认候选始终以词法排序和独立300字符预算准入');
});

test('检索锚点来源失败后沿原顺序补位，重复锚点不重复核验或消费预算',()=>{
 const contacts=Array.from({length:8},(_,n)=>memory(`contact-${n}`));
 const ranked=contacts.map(item=>({id:item.id,versionNo:item.versionNo,score:1}));ranked.splice(1,0,ranked[0]);
 const {source,opened}=lazySource(contacts,{stale:new Set(['contact-1','contact-3'])});
 const selected=selectReplyKnowledge(source,'不相关查询',ranked);
 assert.deepEqual(selected.map(item=>item.id),['contact-0','contact-2','contact-4','contact-5','contact-6']);
 assert.deepEqual(opened,['contact-0','contact-1','contact-2','contact-3','contact-4','contact-5','contact-6']);
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
