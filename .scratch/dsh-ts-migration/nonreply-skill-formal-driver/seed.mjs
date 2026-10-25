/** 冻结来源适配保留版本和作者；既有方法沿真实导入入口形成v1。 */
import {adaptMaterial,stableId} from '../nonreply-formal-runner-preparation/material-adapter.mjs';
import {seedExistingSkill,skillVersions} from '../nonreply-formal-runner-preparation/fixture-state.mjs';
import {sha} from './snapshot.mjs';
export async function seedFixture(f,run){
  const owned={adaptation:adaptMaterial(run)},c=f.client,{owner_id:owner,contact_id:contact}=run.scope;
  const binding=stableId(run.run_id+':binding');
  await c.query("INSERT INTO owner(id,display_name)VALUES($1,'合成本人')",[owner]);
  await c.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成联系人')",[contact,owner]);
  await c.query("INSERT INTO conversation_binding(id,owner_id,contact_id,channel,account_scope,conversation_locator,status)VALUES($1,$2,$3,'wechat','synthetic-skill','synthetic-skill','active')",[binding,owner,contact]);
  for(const s of owned.adaptation.sources){
    const foreign=!s.scoped,contactId=foreign?stableId(s.contact_id):contact;
    if(foreign)await c.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成干扰对象')ON CONFLICT DO NOTHING",[contactId,owner]);
    await c.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count,status,deleted_at)VALUES($1,$2,$3,'manual',$4,$5,$6,$7,$8)",
      [s.storage_id,owner,contactId,s.state==='deleted'?null:'synthetic-only',s.state==='deleted'?null:sha(s.text),s.state==='deleted'?0:1,s.state==='deleted'?'deleted':'active',s.state==='deleted'?s.observed_at:null]);
    if(s.state==='deleted')continue;
    await c.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)VALUES($1,$2,$3,$4,'text',$5,$6)",[s.message_id,owner,contactId,s.speaker,s.text,s.observed_at]);
    await c.query("INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)VALUES($1,$2,$3,'source_document',$4,$5,$6)",
      [s.message_id,owner,contactId,s.storage_id,s.source_id,{time_iso:s.observed_at,text:s.text,speaker:s.speaker}]);
    if(foreign||s.state!=='active')continue;
    const session=stableId(s.storage_id+':session'),input=stableId(s.storage_id+':input');
    await c.query('INSERT INTO assistant_session(id,owner_id,contact_id,is_default)VALUES($1,$2,$3,false)',[session,owner,contact]);
    await c.query("INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,input_type,content,dependency_ids,created_at)VALUES($1,$2,$3,$4,$5,'purpose_exploration',$6,$7,$8)",
      [input,session,owner,contact,binding,{type:'purpose_exploration',purpose_hint:run.material.input.request,correction:s.user_feedback?s.text:'',requirements:'',answer:'',confirmed_intent:'',skill_mode:'auto',skill_version_id:null},[s.message_id,s.storage_id],s.observed_at]);
    await c.query('UPDATE assistant_session SET current_input_version_id=$2 WHERE id=$1',[session,input]);
  }
  await seedExistingSkill(f,run,owned);owned.binding=binding;return owned;
}
export {skillVersions};
