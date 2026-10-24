import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {writeFile} from 'node:fs/promises';
import {setup} from './reply-assistant-erasure-support.mjs';
import {SkillFiles} from '../src/skill-files.ts';
import {validatePackage} from '../src/skill-package.ts';
import {selectMethods,skillDigest,FILTERED_DESCRIPTION} from '../src/skill-execution-view.ts';
import {captureSkillGeneration} from '../src/skill-source-proof.ts';
import {createReplySkillGuards} from '../src/reply-skill-guards.ts';
import {fingerprint} from '../src/reply-assistant-erasure.ts';
import {readReplyBasisChanges} from '../src/reply-source-guards.ts';
async function fixture(t){
 const x=await setup(t),skill=randomUUID(),version=randomUUID(),g=await x.generation(),files=new SkillFiles(join(x.f.directory,'skills'));
 const pkg=validatePackage('gentle-reply',Buffer.from('---\nname: gentle-reply\ndescription: 合成方法\n---\n先听再说。\n'),[]),file=files.prepareVersion(x.owner,skill,version,pkg);
 await x.f.client.query("INSERT INTO reply_skill(id,owner_id,name,status) VALUES($1,$2,'gentle-reply','active')",[skill,x.owner]);
 await x.f.client.query("INSERT INTO reply_skill_version(id,skill_id,version_number,content_sha256,source_locator,enabled,is_current,status,content_path,document_sha256,manifest_sha256)VALUES($1,$2,1,$3,'synthetic',true,true,'active',$4,$5,$6)",[version,skill,file.content_sha256,file.content_path,file.document_sha256,file.manifest_sha256]);
 await x.f.client.query("UPDATE reply_request SET skill_id=$2,skill_version_id=$3,skill_name='gentle-reply',normalized_input=$4,context_snapshot='{}' WHERE id=$1",[g.request,skill,version,JSON.stringify({mode:'reply_to_message',scene:'谈心'})]);
 const scope={owner_id:x.owner,contact_id:x.contact},guards=createReplySkillGuards({files});
 const oracle=request=>execFileSync(join(homedir(),'miniconda3/envs/NotAlone/bin/python'),['-c',"import sys,psycopg\nfrom uuid import UUID\nfrom psycopg.rows import dict_row\nfrom notalone.scopes import ContactScope\nfrom notalone.persistence.skill_execution_view import saved_skill_policy_change\nwith psycopg.connect('host=/tmp dbname='+sys.argv[1],row_factory=dict_row) as c:\n v=saved_skill_policy_change(c,ContactScope(UUID(sys.argv[2]),UUID(sys.argv[3])),UUID(sys.argv[4]))\n print(v or '')",x.f.client.database,x.owner,x.contact,request],{encoding:'utf8',timeout:15000,env:{...process.env,NOTALONE_DISABLE_DOTENV:'1',NOTALONE_SKILLS_DIR:files.root,PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname}}).trim()||null;
 async function check(expected,request=g.request){assert.equal(await guards.savedSkillPolicyChange(x.f.client,scope,request),expected);assert.equal(oracle(request),expected);}
 async function saveView(){
  const row=(await x.f.client.query('SELECT version.*,skill.owner_id,skill.name FROM reply_skill_version version JOIN reply_skill skill ON skill.id=version.skill_id WHERE version.id=$1',[version])).rows[0];
  const s=await selectMethods(x.f.client,{ownerId:x.owner,contactId:x.contact,scene:'谈心'},row);
  const document=s.filtered?'---\nname: '+row.name+'\ndescription: '+JSON.stringify(FILTERED_DESCRIPTION)+'\n---\n# 本次允许的方法\n\n'+files.readMethods(row,s.ordered,s.allowed).map(m=>'## '+m.title+'\n'+m.instruction).join('\n\n'):files.readContent(row);
  const view={policy_revision:s.policyRevision,method_ids:s.allowed,sha256:skillDigest({version_id:version,document,methods:s.allowed,policies:s.policies.map(p=>[p.id,p.revision])})};
  await x.f.client.query('UPDATE reply_request SET context_snapshot=$2 WHERE id=$1',[g.request,{skill_execution_view:view,skill_execution_scene:'谈心'}]);return view;
 }
 return {...x,skill,version,g,files,file,scope,guards,check,saveView};
}
test('历史版本不被当前catalog替代；原scene/执行视图/文件严格复验，与旧Python一致',async t=>{
 const x=await fixture(t),c=x.f.client;await x.check(null);const view=await x.saveView();await x.check(null);
 await c.query('UPDATE reply_skill_version SET enabled=false,is_current=false,directory_available=false WHERE id=$1',[x.version]);await x.check(null);
 await c.query('UPDATE reply_request SET context_snapshot=$2 WHERE id=$1',[x.g.request,{skill_execution_view:{...view,sha256:'0'.repeat(64)},skill_execution_scene:'谈心'}]);await x.check(x.version);
 await x.saveView();await c.query("UPDATE reply_request SET context_snapshot=context_snapshot||'{\"skill_execution_scene\":\"别的场景\"}' WHERE id=$1",[x.g.request]);await x.check(x.version);
 await x.saveView();await c.query("UPDATE reply_request SET normalized_input='suggestion-sha256:synthetic' WHERE id=$1",[x.g.request]);await c.query('UPDATE assistant_session_turn SET input_payload=$2 WHERE id=$1',[x.g.turn,{scene:'谈心'}]);await x.check(null);
 await c.query('UPDATE assistant_session_turn SET input_payload=$2 WHERE id=$1',[x.g.turn,{scene:' 谈心'}]);await x.check(x.version);
 await c.query('UPDATE assistant_session_turn SET input_payload=$2 WHERE id=$1',[x.g.turn,{scene:'谈心'}]);await writeFile(join(x.files.root,x.file.content_path),'损坏的合成正文');await x.check(x.version);
 await assert.rejects(x.guards.requireSavedSkillPolicy(c,x.scope,x.g.request),{code:'reply_input_invalidated'});
});
test('历史审核过滤视图继承祖先停用；政策修订显示变化并保留原快照',async t=>{
 const x=await fixture(t),c=x.f.client,source=randomUUID(),draft=randomUUID(),ancestor=randomUUID();
 await c.query("INSERT INTO conversation_binding(owner_id,contact_id,channel,account_scope,conversation_locator)VALUES($1,$2,'wechat','synthetic','synthetic-contact')",[x.owner,x.contact]);
 await c.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)VALUES($1,$2,$3,'wechat_jsonl','synthetic.jsonl',$4,0)",[source,x.owner,x.contact,'a'.repeat(64)]);
 const proof=await captureSkillGeneration(c,x.owner,x.contact,[source]);
 await c.query("INSERT INTO skill_draft(id,owner_id,contact_id,logical_skill_id,proposal_kind,status,dependency_ids,batch_key)VALUES($1,$2,$3,$4,'create','published',$5,'synthetic')",[draft,x.owner,x.contact,x.skill,[source]]);
 await c.query("INSERT INTO reply_skill_publication(version_id,owner_id,origin_contact_id,draft_id,logical_skill_id,scope_kind,dependency_ids,source_generation)VALUES($1,$2,$3,$4,$5,'owner',$6,$7)",[x.version,x.owner,x.contact,draft,x.skill,[source],{sources:proof}]);
 const methods=[{method_id:randomUUID(),title:'停用',instruction:'合成停用方法'},{method_id:randomUUID(),title:'保留',instruction:'合成保留方法'}],receipt=x.files.prepareMethods(x.owner,x.skill,x.version,methods);
 await c.query('UPDATE reply_skill_version SET review_origin=true,method_manifest_path=$2,method_manifest_sha256=$3 WHERE id=$1',[x.version,receipt.method_manifest_path,receipt.method_manifest_sha256]);
 for(const [i,m]of methods.entries())await c.query("INSERT INTO reply_skill_method(version_id,method_id,logical_skill_id,ordinal,replaces_method_ids,mapping_state)VALUES($1,$2,$3,$4,$5,'confirmed')",[x.version,m.method_id,x.skill,i,i===0?[ancestor]:[]]);
 await c.query("INSERT INTO skill_scope_policy(id,owner_id,skill_id,method_id,scope_kind,contact_id,revision)VALUES($1,$2,$3,$4,'contact',$5,1)",[randomUUID(),x.owner,x.skill,ancestor,x.contact]);
 const view=await x.saveView();assert.deepEqual(view.method_ids,[methods[1].method_id]);await x.check(null);
 await c.query('UPDATE skill_scope_policy SET revision=2 WHERE owner_id=$1',[x.owner]);await x.check(x.version);
 assert.deepEqual(await readReplyBasisChanges(c,x.scope,x.g.request,x.guards.savedSkillPolicyChange),[{evidence_id:x.version,kind:'reply_skill',reason:'skill_policy_changed'}]);
 assert.deepEqual((await c.query('SELECT context_snapshot FROM reply_request WHERE id=$1',[x.g.request])).rows[0].context_snapshot.skill_execution_view,view);
 await c.query("UPDATE reply_request SET context_snapshot='{}' WHERE id=$1",[x.g.request]);await x.check(x.version);
 await c.query('UPDATE skill_scope_policy SET revision=1 WHERE owner_id=$1',[x.owner]);await x.saveView();
 await c.query('UPDATE reply_skill_publication SET deleted=true WHERE version_id=$1',[x.version]);
 assert.equal(await x.guards.savedSkillPolicyChange(c,x.scope,x.g.request),x.version);

});
test('通用回复沿续写/讨论候选继承政策；循环有界且跨scope快照拒绝',async t=>{
 const x=await fixture(t),c=x.f.client,candidate=randomUUID(),child=await x.generation();
 await c.query("INSERT INTO reply_candidate(id,reply_request_id,owner_id,contact_id,conversation_binding_id,ordinal,candidate_text,basis,risk_notes)VALUES($1,$2,$3,$4,$5,0,'合成原稿','合成依据','[]')",[candidate,x.g.request,x.owner,x.contact,x.binding]);
 await c.query('UPDATE reply_request SET continued_from_candidate_id=$2 WHERE id=$1',[child.request,candidate]);await x.check(null,child.request);
 await c.query("INSERT INTO skill_scope_policy(id,owner_id,skill_id,scope_kind,revision)VALUES($1,$2,$3,'owner',1)",[randomUUID(),x.owner,x.skill]);await x.check(x.version,child.request);
 const snapshot={version:1,scope:x.scope,session_id:x.session,request_key:child.key,current_input_version_id:child.input,current_turn_id:child.turn,current_payload_sha256:'a'.repeat(64),records:[{kind:'candidate_version',input_version_id:x.g.input,payload_sha256:'a'.repeat(64),turn_id:x.g.turn,candidate_id:candidate,version_id:randomUUID()}]};
 await c.query('UPDATE reply_request SET continued_from_candidate_id=NULL,context_snapshot=$2 WHERE id=$1',[child.request,{assistant_discussion_snapshot:snapshot}]);await x.check(x.version,child.request);
 await c.query('DELETE FROM skill_scope_policy WHERE owner_id=$1',[x.owner]);await c.query('UPDATE reply_request SET continued_from_candidate_id=$2 WHERE id=$1',[x.g.request,candidate]);await x.check(null,child.request);
 await c.query('UPDATE reply_request SET context_snapshot=$2 WHERE id=$1',[child.request,{assistant_discussion_snapshot:{...snapshot,scope:{...x.scope,contact_id:randomUUID()}}}]);await x.check(child.request,child.request);
});
test('跨会话候选携入不能洗掉原技能政策；真实版本/选择/指纹边校验',async t=>{
 const x=await fixture(t),c=x.f.client,candidate=randomUUID(),selection=randomUUID(),childSession=randomUUID(),carry=randomUUID();
 const group=[{message_id:candidate,text:'合成旧候选'}];
 await c.query("UPDATE reply_request SET state='completed',skill_library_revision=0 WHERE id=$1",[x.g.request]);await c.query("UPDATE assistant_session_turn SET state='completed' WHERE id=$1",[x.g.turn]);
 await c.query("INSERT INTO reply_candidate(id,reply_request_id,owner_id,contact_id,conversation_binding_id,ordinal,candidate_text,basis,risk_notes,message_group)VALUES($1,$2,$3,$4,$5,0,'合成旧候选','合成依据','[]',$6)",[candidate,x.g.request,x.owner,x.contact,x.binding,JSON.stringify(group)]);
 await c.query('INSERT INTO assistant_candidate_version(id,owner_id,contact_id,session_id,turn_id,candidate_id,version_number)VALUES($1,$2,$3,$4,$5,$1,0)',[candidate,x.owner,x.contact,x.session,x.g.turn]);
 await c.query('INSERT INTO assistant_candidate_selection(id,owner_id,contact_id,session_id,selection_key,selection_number,candidate_id,version_id)VALUES($1,$2,$3,$4,$5,1,$6,$6)',[selection,x.owner,x.contact,x.session,randomUUID(),candidate]);
 await c.query('INSERT INTO assistant_session(id,owner_id,contact_id,is_default)VALUES($1,$2,$3,false)',[childSession,x.owner,x.contact]);
 const child=await x.generation([],null,childSession);
 const origin={type:'candidate_carry',metadata_version:2,origin_owner_id:x.owner,origin_contact_id:x.contact,origin_binding_id:x.binding,origin_session_id:x.session,origin_input_version_id:x.g.input,origin_turn_id:x.g.turn,origin_reply_request_id:x.g.request,origin_candidate_id:candidate,origin_version_id:candidate,origin_selection_id:selection,payload_sha256:fingerprint(group)};
 await c.query("INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,input_type,content)VALUES($1,$2,$3,$4,$5,'candidate_carry',$6)",[carry,childSession,x.owner,x.contact,x.binding,JSON.stringify(origin)]);
 const snapshot={version:1,scope:x.scope,session_id:childSession,request_key:child.key,current_input_version_id:child.input,current_turn_id:child.turn,current_payload_sha256:'a'.repeat(64),records:[{kind:'discussion_input',input_version_id:carry,payload_sha256:'a'.repeat(64),turn_id:null,candidate_id:null,version_id:null}]};
 await c.query('UPDATE reply_request SET context_snapshot=$2 WHERE id=$1',[child.request,{assistant_discussion_snapshot:snapshot}]);await x.check(null,child.request);
 await c.query("INSERT INTO skill_scope_policy(id,owner_id,skill_id,scope_kind,revision)VALUES($1,$2,$3,'owner',1)",[randomUUID(),x.owner,x.skill]);await x.check(x.version,child.request);
 await c.query('DELETE FROM skill_scope_policy WHERE owner_id=$1',[x.owner]);
 await c.query('UPDATE assistant_session_input SET content=$2 WHERE id=$1',[carry,{...origin,payload_sha256:'0'.repeat(64)}]);
 // 比旧policy-only检查更严格：复用已迁业务父边核验，拒绝伪造携入指纹。
 assert.equal(await x.guards.savedSkillPolicyChange(c,x.scope,child.request),child.request);
});
test('继承图上限拒绝，数据库故障不被冒充政策变化',async()=>{
 const request=randomUUID(),scope={owner_id:randomUUID(),contact_id:randomUUID()},guard=createReplySkillGuards({files:new SkillFiles('/tmp/notalone-unused-synthetic-skills')});
 let visited=0;
 const client={query:async sql=>{
  if(sql.includes('request.skill_version_id IS NOT NULL')){visited++;return {rows:[]};}
  if(sql.includes('SELECT context_snapshot'))return {rows:[{context_snapshot:{},continued_from_candidate_id:randomUUID()}]};
  if(sql.includes('SELECT reply_request_id'))return {rows:[{reply_request_id:randomUUID()}]};
  throw new Error('unexpected_query');
 }};
 assert.equal(await guard.savedSkillPolicyChange(client,scope,request),request);assert.equal(visited,256);
 const broken={query:async()=>{throw new Error('synthetic_db_unavailable');}};
 await assert.rejects(guard.savedSkillPolicyChange(broken,scope,request),/synthetic_db_unavailable/);
});
