import {randomUUID} from 'node:crypto';
import {registry as base} from './registry.mjs';
import {registry as typed} from './adjudication-upgrade-registry.mjs?mode=upgrade';
import {verifiedExtractionOutput} from '../../../src/memory/sqlite/outputs.ts';
export const registry={...base,actions:[...base.actions,{name:'fixture.legacyPolicyArchive',mode:'write',retryBusy:false,execute(tx,i){tx.run('UPDATE processing_run SET policy_config=? WHERE owner_id=? AND id=?',[JSON.stringify({version:1,mode:'legacy',rule_set_sha256:null}),i.ownerId,i.runId]);}},...typed.actions.filter(a=>['fixture.typedAdjudication','fixture.typedPublish'].includes(a.name)),
 {name:'fixture.recoverKnownAttempt',mode:'write',retryBusy:false,execute(tx,i,lease){
  tx.run('UPDATE step_attempt SET runtime_token=? WHERE owner_id=? AND id=?',[randomUUID(),i.ownerId,i.attemptId]);
  return base.actions.find(a=>a.name==='memoryExtraction.recover').execute(tx,{ownerId:i.ownerId},lease);
 }},
 {name:'fixture.oldSourceStamp',mode:'write',retryBusy:false,execute(tx,i){
  const row=tx.get('SELECT policy_config FROM processing_run WHERE owner_id=? AND id=?',[i.ownerId,i.runId]),config=JSON.parse(row.policy_config);config.source_stamp='0'.repeat(64);
  tx.run('UPDATE processing_run SET policy_config=? WHERE owner_id=? AND id=?',[JSON.stringify(config),i.ownerId,i.runId]);return true;
 }},
 {name:'fixture.archiveWholeWindow',mode:'write',retryBusy:false,execute(tx,i){
  const c=tx.get('SELECT * FROM memory_candidate WHERE owner_id=? AND id=?',[i.ownerId,i.candidateId]),out=verifiedExtractionOutput(tx,{ownerId:i.ownerId,eventId:c.event_id});
  const parents=[{candidateId:c.id},...(i.memoryId?[{memoryId:i.memoryId,versionNo:1n}]:[])];
  for(const p of parents){
   tx.run(`DELETE FROM memory_citation WHERE owner_id=? AND ${p.candidateId?'candidate_id=?':'memory_id=? AND version_no=?'}`,p.candidateId?[i.ownerId,p.candidateId]:[i.ownerId,p.memoryId,p.versionNo]);
   for(const source of out.sources){
    const m=tx.get('SELECT text_body FROM message WHERE owner_id=? AND contact_id=? AND id=?',[i.ownerId,source.contactId,source.messageId]);
    if(!tx.get(`SELECT 1 FROM memory_required_message WHERE owner_id=? AND source_contact_id=? AND message_id=? AND ${p.candidateId?'candidate_id=?':'memory_id=? AND version_no=?'}`,p.candidateId?[i.ownerId,source.contactId,source.messageId,p.candidateId]:[i.ownerId,source.contactId,source.messageId,p.memoryId,p.versionNo]))tx.run('INSERT INTO memory_required_message VALUES(?,?,?,?,?,?,?)',[i.ownerId,randomUUID(),p.candidateId??null,p.memoryId??null,p.versionNo??null,source.contactId,source.messageId]);
    tx.run('INSERT INTO memory_citation(owner_id,id,candidate_id,memory_id,version_no,source_contact_id,message_id,record_id,accepted_revision,span_start,span_end,explanation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[i.ownerId,randomUUID(),p.candidateId??null,p.memoryId??null,p.versionNo??null,source.contactId,source.messageId,source.recordId,source.interpretationRevision,0n,BigInt([...m.text_body].length),null]);
   }
  }return true;
 }},
 {name:'fixture.archiveState',mode:'read',retryBusy:false,execute(tx,i){return {
  citations:tx.all('SELECT * FROM memory_citation WHERE owner_id=? ORDER BY id',[i.ownerId]),required:tx.all('SELECT * FROM memory_required_message WHERE owner_id=? ORDER BY id',[i.ownerId]),
  events:tx.all('SELECT id,payload FROM execution_event WHERE owner_id=? ORDER BY id',[i.ownerId]),eventSources:tx.all('SELECT * FROM event_source WHERE owner_id=? ORDER BY event_id,record_id',[i.ownerId]),
 };}},
]};
