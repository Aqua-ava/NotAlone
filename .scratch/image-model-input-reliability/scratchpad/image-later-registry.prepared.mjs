import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {assertInputs} from '../../../src/memory/sqlite/qualification.ts';
export const registry={...base,actions:[...base.actions,{
 name:'fixture.imageLaterInputs',mode:'read',retryBusy:false,execute(tx,input){
  return tx.all(`SELECT r.id AS run_id,json_extract(r.policy_config,'$.stage') AS stage,i.input_no,i.message_id,c.plugin_id,c.plugin_version,c.content_kind,c.identity_json
   FROM processing_run r JOIN run_input i ON i.owner_id=r.owner_id AND i.run_id=r.id
   LEFT JOIN run_content_input c ON c.owner_id=i.owner_id AND c.run_id=i.run_id AND c.input_no=i.input_no
   WHERE r.owner_id=? AND json_extract(r.policy_config,'$.intent')='memory_document_later_stage' ORDER BY r.started_at,r.id,i.input_no`,[input.ownerId]);
 }
},{
 name:'fixture.imageLaterRevalidate',mode:'read',retryBusy:false,execute(tx,input){
  assertInputs(tx,input.ownerId,input.runId,tx.all('SELECT * FROM run_input WHERE owner_id=? AND run_id=? ORDER BY input_no',[input.ownerId,input.runId]));return true;
 }
},{
 name:'fixture.imageLaterDigestChange',mode:'write',retryBusy:false,execute(tx,input){
  tx.run('UPDATE media_file SET content_digest=? WHERE owner_id=? AND id=?',['0'.repeat(64),input.ownerId,input.fileId]);
 }
}]};
