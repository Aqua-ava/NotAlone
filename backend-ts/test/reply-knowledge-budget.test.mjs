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
