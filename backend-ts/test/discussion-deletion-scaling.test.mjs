import test from 'node:test';
import assert from 'node:assert/strict';
import {collectDiscussionDeletionImpact} from '../src/reply/sqlite/deletion.ts';

function transaction(rows, counts = {queries:0}) {
 return {
  get(sql) { counts.queries++; return sql.includes("name='reply_candidate_request'") ? {present:1} : undefined; },
  all(sql) {
   counts.queries++;
   if(sql.includes('JOIN request_tombstone') || sql.includes('cleanup_operation_id=?')) return [];
   if(sql.includes('JOIN reply_selection')) return rows.carried ?? [];
   const table=/FROM (\w+)/.exec(sql)?.[1];
   return rows[table] ?? [];
  },
 };
}
const operation={ownerId:'synthetic-owner',operationId:'synthetic-delete',acceptedGeneration:1n,
 scope:{kind:'source',contactId:'synthetic-contact',sourceId:'synthetic-source'}};

test('删除影响沿副本后续、显式继续、引用发言及准备副本传播，保留早期和独立内容',()=>{
 const rows={
  assistant_discussion:[{id:'discussion'}],
  reply_context:['early','seed','later','carried','entry','independent'].map(id=>({id,discussion_id:'discussion',request_id:`request-${id}`})),
  reply_request:['early','seed','later','carried','entry','independent'].map(id=>({id:`request-${id}`,discussion_id:'discussion'})),
  reply_context_item:[{context_id:'seed',kind:'message',source_contact_id:'synthetic-contact',record_id:'synthetic-source'},
   {context_id:'entry',kind:'entry',entry_id:'carried-entry'}],
  discussion_entry:[{id:'carried-entry',origin_request_id:'request-carried'}],
  runtime_context:[{context_id:'early',copy_id:'shared',incorporation_no:1n},{context_id:'seed',copy_id:'shared',incorporation_no:2n},
   {context_id:'later',copy_id:'shared',incorporation_no:3n},{context_id:'independent',copy_id:'independent-copy',incorporation_no:1n}],
  reply_attempt:[{id:'preparing-attempt',request_id:'request-entry'}],
  runtime_copy:[{id:'shared',discussion_id:'discussion',preparing_attempt_id:null},{id:'independent-copy',discussion_id:'discussion',preparing_attempt_id:null},
   {id:'preparing-copy',discussion_id:'discussion',preparing_attempt_id:'preparing-attempt'}],
  carried:[{request_id:'request-carried',origin_request:'request-later'}],
 };
 const result=collectDiscussionDeletionImpact(transaction(rows),operation);
 assert.deepEqual(result.contextIds,['carried','entry','later','seed']);
 assert.deepEqual(result.requestIds,['request-carried','request-entry','request-later','request-seed']);
 assert.deepEqual(result.runtimeCopyIds,['preparing-copy','shared']);
 assert.deepEqual(result.entryIds,['carried-entry']);
 assert.deepEqual(result.attemptIds,['preparing-attempt']);
});

export function measureDeletionWork(count) {
 let copyReads=0;
 const rows={assistant_discussion:[{id:'discussion'}],
  reply_context:Array.from({length:count},(_,i)=>({id:`context-${i}`,discussion_id:'discussion',request_id:null})),
  runtime_context:Array.from({length:count},(_,i)=>({context_id:`context-${i}`,get copy_id(){copyReads++;return `copy-${i}`;},incorporation_no:1n})),
 };
 const result=collectDiscussionDeletionImpact(transaction(rows),{...operation,scope:{kind:'discussion',contactId:'synthetic-contact',discussionId:'discussion'}});
 assert.equal(result.contextIds.length,count);assert.equal(result.runtimeCopyIds.length,count);
 return copyReads;
}

test('大量独立运行副本的删除影响计算不会逐条重扫全部副本',()=>{
 const small=measureDeletionWork(100),large=measureDeletionWork(1000);
 assert.ok(large<=small*15,`记录增至10倍时工作量不应平方增长：${small} → ${large}`);
 assert.ok(large<100_000,`1000条元数据不应反复访问数百万次：${large}`);
});
