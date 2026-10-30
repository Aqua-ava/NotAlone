import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {memoryExtractionMigration} from '../../../src/memory/sqlite/schema.ts';
import {memoryExecutionMigration} from '../../../src/memory/sqlite/execution-schema.ts';
import {discussionMigration} from '../../../src/reply/sqlite/schema.ts';
import {discussionActions} from '../../../src/reply/sqlite/actions.ts';
import {discussionRequestActions} from '../../../src/reply/sqlite/requests.ts';
import {runtimeActions} from '../../../src/reply/sqlite/runtime-actions.ts';
import {discussionModelActions} from '../../../src/reply/sqlite/model-actions.ts';
const installed=base.migrations.some(m=>m.sql.includes('CREATE TABLE assistant_discussion'));
const migrations=installed?[...base.migrations]:[...base.migrations,discussionMigration(base.migrations.length+1)];
if(!migrations.some(m=>m.sql.includes('CREATE TABLE processing_run')))migrations.push(memoryExtractionMigration(migrations.length+1));
if(!migrations.some(m=>m.sql.includes('CREATE TABLE operation_scope')))migrations.push(memoryExecutionMigration(migrations.length+1));
export const registry={migrations,
 actions:[...base.actions,...[...discussionActions,...discussionRequestActions,...runtimeActions,...discussionModelActions].filter(a=>!base.actions.some(b=>b.name===a.name)),
  // 仅在测试里模拟发送授权已登记后进程中断；不执行或声称发生真实网络请求。
  {name:'discussionTest.markSending',mode:'write',retryBusy:false,execute(tx,i){
   const call=tx.get("SELECT operation_id FROM model_call WHERE owner_id=? AND id=? AND state='prepared'",[i.ownerId,i.callId]);
   if(!call)throw new Error('合成故障必须指向真实准备调用');
   tx.run("UPDATE model_call SET state='sending',sent_at=1 WHERE owner_id=? AND id=?",[i.ownerId,i.callId]);
   tx.run("UPDATE model_operation SET state='in_flight' WHERE owner_id=? AND id=?",[i.ownerId,call.operation_id]);
   tx.run("UPDATE operation_scope SET state='sent' WHERE owner_id=? AND operation_id=?",[i.ownerId,call.operation_id]);
  }},
  {name:'discussionTest.recoveryState',mode:'read',retryBusy:false,execute(tx,i){return tx.get(`SELECT a.state attempt_state,r.state request_state,c.state call_state,c.settlement_state,
   o.state operation_state,o.commit_forbidden_at,s.state scope_state FROM reply_attempt a
   JOIN reply_request r ON r.owner_id=a.owner_id AND r.id=a.request_id
   JOIN model_call c ON c.owner_id=a.owner_id AND c.reply_attempt_id=a.id
   JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id
   JOIN operation_scope s ON s.owner_id=o.owner_id AND s.operation_id=o.id AND s.source_contact_id=r.contact_id
   WHERE a.owner_id=? AND a.id=?`,[i.ownerId,i.attemptId]);}},
 ]};
