import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {recordExtractionModelReceipt} from '../src/memory/extraction/model.ts';
import {ModelLedgerError} from '../src/platform/models/model-ledger-contract.ts';
const privateText='合成内部正文，不得出现在调用错误中';
const cases=[['原台账类型和删除code',new ModelLedgerError('model_ledger_scope_deleted'),true],['普通Error同message',new Error('model_ledger_scope_deleted'),false],['普通Error伪造code',Object.assign(new Error(privateText),{code:'model_ledger_scope_deleted'}),false],['其他台账code',new ModelLedgerError(privateText),false],['普通对象伪造code',{code:'model_ledger_scope_deleted',message:privateText},false],['已确认类型不透传message',Object.assign(new ModelLedgerError('model_ledger_scope_deleted'),{message:privateText}),true]];
for(const [name,error,deleted] of cases)test('进程内账本受限删除原因：'+name,async()=>{
 const receipt={attempt_id:randomUUID(),permit_id:randomUUID(),request_id:randomUUID(),owner_id:randomUUID(),contact_id:randomUUID(),provider:'synthetic',model:'synthetic',called_at:'2026-10-24T00:00:00Z',latency_ms:null,dispatch:'authorized_unconfirmed',outcome:'pending',usage:null,cost:{status:'unknown',amount:null,currency:null,pricing_version:null}};
 let received;
 await assert.rejects(recordExtractionModelReceipt({recordReserved:async value=>{received=value;throw error;}},receipt),failure=>{
  assert.equal(failure.code,deleted?'extraction_model_scope_deleted':'extraction_model_ack_unknown');assert.equal(JSON.stringify(failure).includes(privateText),false);return true;
 });
 assert.deepEqual(received,receipt);
});
