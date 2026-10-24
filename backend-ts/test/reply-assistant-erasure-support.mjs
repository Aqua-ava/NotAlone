import {randomUUID} from 'node:crypto';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {createAssistantErasure} from '../src/reply-assistant-erasure.ts';
export async function setup(t) {
 const f=await createStorageFixture();t.after(()=>f.close());const owner=randomUUID(),contact=randomUUID(),binding=randomUUID(),session=randomUUID();
 await f.client.query("INSERT INTO owner(id,display_name)VALUES($1,'合成本人')",[owner]);
 await f.client.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成联系人')",[contact,owner]);
 await f.client.query('INSERT INTO assistant_session(id,owner_id,contact_id)VALUES($1,$2,$3)',[session,owner,contact]);
 const calls=[];const erase=createAssistantErasure({eraseSkillLearning:async(c,o,ids)=>calls.push(ids)});
 async function generation(dependencies=[],parent=null,ownSession=session){
  const turn=randomUUID(),input=randomUUID(),key=randomUUID(),request=randomUUID();
  const payload={content:{type:'reply_to_message',text:'合成输入'},...(parent?{continuation:{version:1,scope:'this_assistant_session_only',submission:{expected_input_version_id:parent.input,idempotency_key:key,displayed_group:{session_id:ownSession}}}}:{})};
  await f.client.query("INSERT INTO reply_request(id,owner_id,contact_id,conversation_binding_id,idempotency_key,normalized_input,state,attempt,lease_expires_at)VALUES($1,$2,$3,$4,$5,'synthetic','running',1,now()+interval '30 seconds')",[request,owner,contact,binding,key]);
  await f.client.query("INSERT INTO assistant_session_turn(id,session_id,owner_id,contact_id,input_version_id,idempotency_key,conversation_binding_id,input_digest,input_payload,dependency_ids,reply_request_id,prepared_context)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",[turn,ownSession,owner,contact,input,key,binding,'a'.repeat(64),JSON.stringify(payload),dependencies,request,JSON.stringify({synthetic:'准备副本'})]);
  await f.client.query("INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,input_type,turn_id)VALUES($1,$2,$3,$4,$5,'generation',$6)",[input,ownSession,owner,contact,binding,turn]);
  await f.client.query('UPDATE assistant_session SET current_input_version_id=$2 WHERE id=$1',[ownSession,input]);
  return {turn,input,key,request,payload,session:ownSession};
 }
 async function run(removed,requests){await f.client.query('BEGIN');try{const result=await erase(f.client,owner,removed,requests);await f.client.query('COMMIT');return result;}catch(e){await f.client.query('ROLLBACK');throw e;}}
 return {f,owner,contact,binding,session,erase,run,generation,calls};
}
