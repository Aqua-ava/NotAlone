import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {PostgresSkillPort} from '../src/skill-port.ts';
test('受控目录仅限已有联系人，空库读路径无写入',async()=>{
 const f=await createStorageFixture();
 try{
  const owner=randomUUID(),contact=randomUUID();
  await f.client.query('INSERT INTO owner(id,display_name) VALUES($1,$2)',[owner,'合成用户']);
  await f.client.query('INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,$3)',[contact,owner,'合成联系人']);
  const db={read:async fn=>{await f.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');try{const value=await fn(f.client);await f.client.query('COMMIT');return value;}catch(e){await f.client.query('ROLLBACK');throw e;}}};
  const p=new PostgresSkillPort(db,`${f.directory}/skills`);
  await assert.rejects(p.catalog({ownerId:owner,contactId:contact,scene:''}),{code:'skill_unavailable'});
  await f.client.query("INSERT INTO conversation_binding(owner_id,contact_id,channel,account_scope,conversation_locator) VALUES($1,$2,'wechat','synthetic','contact-a')",[owner,contact]);
  assert.deepEqual(await p.catalog({ownerId:owner,contactId:contact,scene:''}),{revision:'0',entries:[]});
  await assert.rejects(p.catalog({ownerId:owner,contactId:randomUUID(),scene:''}),{code:'skill_unavailable'});
  await f.client.query("UPDATE conversation_binding SET status='revoked',revoked_at=now() WHERE owner_id=$1",[owner]);
  await assert.rejects(p.catalog({ownerId:owner,contactId:contact,scene:''}),{code:'skill_unavailable'});
  await f.client.query('INSERT INTO manual_contact_confirmation(owner_id,contact_id) VALUES($1,$2)',[owner,contact]);
  assert.deepEqual(await p.catalog({ownerId:owner,contactId:contact,scene:''}),{revision:'0',entries:[]});
 }finally{await f.close();}
});

import {mkdir,writeFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {HostStorage} from '../src/host-storage.ts';
import {SkillFiles} from '../src/skill-files.ts';
import {SkillLibrary} from '../src/skill-library.ts';
async function setup(t){
 const f=await createStorageFixture();t.after(()=>f.close());
 const storage=await HostStorage.open(f.options);t.after(()=>storage.close());await storage.initializeOwner('合成用户');
 const owner=storage.runtimeOwnerId,contact=randomUUID(),scope={ownerId:owner,contactId:contact,scene:''};
 await f.client.query('INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,$3)',[contact,owner,'合成联系人']);
 await f.client.query('INSERT INTO manual_contact_confirmation(owner_id,contact_id) VALUES($1,$2)',[owner,contact]);
 const path=join(f.directory,'gentle-reply');await mkdir(join(path,'references'),{recursive:true});
 await writeFile(join(path,'SKILL.md'),'---\nname: gentle-reply\ndescription: "温和回应"\n---\n\n先回应感受。\n');
 await writeFile(join(path,'references','sample.txt'),'合成参考。');
 const root=join(f.directory,'skills'),files=new SkillFiles(root),library=new SkillLibrary(storage,files);
 const imported=await library.handle('POST',new URL('http://local/api/skills/import'),{package_path:path});
 const db={read:async fn=>{await f.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');try{const v=await fn(f.client);await f.client.query('COMMIT');return v;}catch(e){await f.client.query('ROLLBACK');throw e;}}};
 const port=new PostgresSkillPort(db,root),catalog=await port.catalog(scope),entry=catalog.entries[0];assert.ok(entry);
 return {f,storage,scope,root,files,library,port,catalog,entry,imported};
}
test('实际读取返回完整原SkillUse，不能伪造已读资源',async t=>{
 const {scope,port,catalog,entry}=await setup(t);
 await assert.rejects(port.captureUse(scope,entry,catalog.revision,{}),{code:'skill_unavailable'});
 await port.loadVersion(scope,entry,catalog.revision);
 await assert.rejects(port.captureUse(scope,entry,catalog.revision,{resource_paths:['references/sample.txt']}),{code:'skill_unavailable'});
 await port.resource(scope,entry,catalog.revision,'references/sample.txt');
 const use=await port.captureUse(scope,entry,catalog.revision,{selection_method:'user',selection_reason:'用户选择',resource_paths:['references/sample.txt']});
 assert.equal(use.skill_id,entry.skillId);assert.equal(use.version_id,entry.versionId);assert.equal(use.name,'gentle-reply');
 assert.equal(use.version_number,1);assert.equal(use.scope_kind,'owner');assert.equal(use.scope_contact_id,null);assert.equal(use.scope_scene,null);
 assert.equal(use.selection_method,'user');assert.equal(use.selection_reason,'用户选择');assert.deepEqual(use.resource_paths,['references/sample.txt']);assert.equal(use.load_state,'loaded');
 assert.equal(use.execution_view.policy_revision,0);assert.match(use.execution_view.sha256,/^[a-f0-9]{64}$/);assert.equal(use.execution_view.method_ids.length,1);
});
test('提交同一client重验实际资源字节，目录修订未变也拒绝',async t=>{
 const {f,scope,port,catalog,entry,root}=await setup(t);
 await port.loadVersion(scope,entry,catalog.revision);await port.resource(scope,entry,catalog.revision,'references/sample.txt');
 await f.client.query('BEGIN');
 try{
  await port.validateInTransaction(f.client,scope,catalog.revision,entry);
  const row=(await f.client.query('SELECT content_path FROM reply_skill_version WHERE id=$1',[entry.versionId])).rows[0];
  await writeFile(join(root,dirname(row.content_path),'references/sample.txt'),'已被修改。');
  await assert.rejects(port.validateInTransaction(f.client,scope,catalog.revision,entry),{code:'reply_input_invalidated'});
 }finally{await f.client.query('ROLLBACK');}
});
test('工作目录未同步的编辑也使已读版本提交失效',async t=>{
 const {f,scope,port,catalog,entry,root}=await setup(t);await port.loadVersion(scope,entry,catalog.revision);
 await writeFile(join(root,scope.ownerId,entry.name,'SKILL.md'),'---\nname: gentle-reply\ndescription: "温和回应"\n---\n\n已修改的工作正文。\n');
 await assert.rejects(port.validateInTransaction(f.client,scope,catalog.revision,entry),{code:'reply_input_invalidated'});
});
test('SkillUse提交只能使用本轮实际凭证，不能重造版本或执行视图',async t=>{
 const {f,scope,port,catalog,entry}=await setup(t);await port.loadVersion(scope,entry,catalog.revision);
 const use=await port.captureUse(scope,entry,catalog.revision,{});
 await port.validateUseInTransaction(f.client,scope,catalog.revision,use);
 await assert.rejects(port.validateUseInTransaction(f.client,scope,catalog.revision,{...use,version_number:2}),{code:'reply_input_invalidated'});
 await assert.rejects(port.validateUseInTransaction(f.client,scope,catalog.revision,{...use,execution_view:{...use.execution_view,sha256:'0'.repeat(64)}}),{code:'reply_input_invalidated'});
 await f.client.query('DELETE FROM manual_contact_confirmation WHERE owner_id=$1',[scope.ownerId]);
 await assert.rejects(port.validateUseInTransaction(f.client,scope,catalog.revision,use),{code:'reply_input_invalidated'});
});
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {captureSkillNavigation} from '../src/skill-source-navigation.ts';
import {captureSkillGeneration,requireReviewSources} from '../src/skill-source-proof.ts';
function pythonProof(f,scope,source,version,memory=null,memoryKind='owner'){
 const script=`import json,sys,psycopg\nfrom uuid import UUID\nfrom notalone.scopes import ContactScope\nfrom notalone.persistence.skill_learning_generation import capture_generation\nfrom notalone.persistence.skill_review_navigation import capture_review_sources\nscope=ContactScope(UUID(sys.argv[2]),UUID(sys.argv[3]))\nsource=UUID(sys.argv[4]);version=UUID(sys.argv[5])\nwith psycopg.connect('host=/tmp dbname='+sys.argv[1]) as c:\n v1=capture_generation(c,scope,{source})\n deps2,v2=capture_review_sources(c,scope,{source},set(),[])\n deps3,v3=capture_review_sources(c,scope,{source},set(),[],[{'version_id':str(version)}])\n result={'v1':v1,'v2':v2,'deps2':list(deps2),'v3':v3,'deps3':list(deps3)}\n if sys.argv[6]!='null':\n  memory=UUID(sys.argv[6]);navigation=[{'scope_kind':sys.argv[7],'memory_id':str(memory),'memory_revision':1,'dependency_ids':[str(scope.owner_id if sys.argv[7]=='owner' else source)]}]\n  deps,proof=capture_review_sources(c,scope,set(),set(),navigation)\n  result.update(navigation=proof,navigation_deps=list(deps))\n print(json.dumps(result,default=str))\n`;
 return JSON.parse(execFileSync(join(homedir(),'miniconda3/envs/NotAlone/bin/python'),['-c',script,f.client.database,scope.ownerId,scope.contactId,source,version,memory??'null',memoryKind],{encoding:'utf8',timeout:15000,env:{...process.env,PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname,NOTALONE_DISABLE_DOTENV:'1'}}));
}
test('真实旧Python proof v1/v2/v3由TS核验且原来源变化拒绝',async t=>{
 const {f,scope,entry}=await setup(t),source=randomUUID();
 await f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'wechat_jsonl','synthetic.jsonl',$4,0)",[source,scope.ownerId,scope.contactId,'a'.repeat(64)]);
 const proof=pythonProof(f,scope,source,entry.versionId);
 assert.deepEqual(await captureSkillGeneration(f.client,scope.ownerId,scope.contactId,[source]),proof.v1);
 for(const [version,deps] of [[proof.v1,[source]],[proof.v2,proof.deps2],[proof.v3,proof.deps3]])await requireReviewSources(f.client,scope.ownerId,scope.contactId,deps,version);
 await f.client.query("UPDATE source_document SET content_sha256=$2 WHERE id=$1",[source,'b'.repeat(64)]);
 for(const [version,deps] of [[proof.v1,[source]],[proof.v2,proof.deps2],[proof.v3,proof.deps3]])await assert.rejects(requireReviewSources(f.client,scope.ownerId,scope.contactId,deps,version),{code:'skill_unavailable'});
});
test('旧Python本人手录导航proof逐字段等价，撤销记忆后拒绝',async t=>{
 const {f,scope,entry}=await setup(t),source=randomUUID(),memory=randomUUID();
 await f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'wechat_jsonl','synthetic.jsonl',$4,0)",[source,scope.ownerId,scope.contactId,'a'.repeat(64)]);
 await f.client.query("INSERT INTO owner_memory(id,owner_id,text_content,category,source_ids,adoption_method) VALUES($1,$2,'合成本人偏好','preference',$3,'manual')",[memory,scope.ownerId,[scope.ownerId]]);
 const proof=pythonProof(f,scope,source,entry.versionId,memory);
 assert.deepEqual(await captureSkillNavigation(f.client,scope.ownerId,scope.contactId,proof.navigation.navigation.map(p=>p.identity)),proof.navigation.navigation);
 await requireReviewSources(f.client,scope.ownerId,scope.contactId,proof.navigation_deps,proof.navigation);
 await f.client.query("UPDATE owner_memory SET status='deleted' WHERE id=$1",[memory]);
 await assert.rejects(requireReviewSources(f.client,scope.ownerId,scope.contactId,proof.navigation_deps,proof.navigation),{code:'skill_unavailable'});
});
test('审核方法继承祖先停用，资源不能绕过筛选，政策变化使旧视图失效',async t=>{
 const {f,scope,entry,port,files}=await setup(t),source=randomUUID(),draft=randomUUID(),ancestor=randomUUID();
 await f.client.query("INSERT INTO conversation_binding(owner_id,contact_id,channel,account_scope,conversation_locator) VALUES($1,$2,'wechat','synthetic','contact-a')",[scope.ownerId,scope.contactId]);
 await f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'wechat_jsonl','synthetic.jsonl',$4,0)",[source,scope.ownerId,scope.contactId,'a'.repeat(64)]);
 const proof=pythonProof(f,scope,source,entry.versionId).v1;
 await f.client.query("INSERT INTO skill_draft(id,owner_id,contact_id,logical_skill_id,proposal_kind,status,dependency_ids,batch_key) VALUES($1,$2,$3,$4,'create','published',$5,'synthetic')",[draft,scope.ownerId,scope.contactId,entry.skillId,[source]]);
 await f.client.query("INSERT INTO reply_skill_publication(version_id,owner_id,origin_contact_id,draft_id,logical_skill_id,scope_kind,dependency_ids,source_generation) VALUES($1,$2,$3,$4,$5,'owner',$6,$7)",[entry.versionId,scope.ownerId,scope.contactId,draft,entry.skillId,[source],{sources:proof}]);
 const methods=[{method_id:randomUUID(),title:'停用方法',instruction:'不应读取的合成方法。'},{method_id:randomUUID(),title:'允许方法',instruction:'允许的合成方法。'}],receipt=files.prepareMethods(scope.ownerId,entry.skillId,entry.versionId,methods);
 await f.client.query('UPDATE reply_skill_version SET review_origin=true,method_manifest_path=$2,method_manifest_sha256=$3 WHERE id=$1',[entry.versionId,receipt.method_manifest_path,receipt.method_manifest_sha256]);
 for(const [ordinal,m] of methods.entries())await f.client.query("INSERT INTO reply_skill_method(version_id,method_id,logical_skill_id,ordinal,replaces_method_ids,mapping_state) VALUES($1,$2,$3,$4,$5,'confirmed')",[entry.versionId,m.method_id,entry.skillId,ordinal,ordinal===0?[ancestor]:[]]);
 await f.client.query("INSERT INTO skill_scope_policy(id,owner_id,skill_id,method_id,scope_kind,contact_id,revision) VALUES($1,$2,$3,$4,'contact',$5,1)",[randomUUID(),scope.ownerId,entry.skillId,ancestor,scope.contactId]);
 const catalog=await port.catalog(scope),selected=catalog.entries[0];assert.ok(selected);assert.deepEqual(selected.resourcePaths,[]);
 const loaded=await port.loadVersion(scope,selected,catalog.revision);assert.match(loaded.content,/允许的合成方法/);assert.doesNotMatch(loaded.content,/不应读取/);
 const use=await port.captureUse(scope,selected,catalog.revision,{});assert.deepEqual(use.execution_view.method_ids,[methods[1].method_id]);assert.equal(use.execution_view.policy_revision,1);
 const script="import sys,json\nfrom uuid import UUID\nfrom notalone.scopes import ContactScope\nfrom notalone.persistence.skill_port import PostgresSkillPort\nv=PostgresSkillPort('host=/tmp dbname='+sys.argv[1]).load_version(ContactScope(UUID(sys.argv[2]),UUID(sys.argv[3])),UUID(sys.argv[4]))\nprint(json.dumps(v.execution_view.to_payload()))";
 const original=JSON.parse(execFileSync(join(homedir(),'miniconda3/envs/NotAlone/bin/python'),['-c',script,f.client.database,scope.ownerId,scope.contactId,entry.versionId],{encoding:'utf8',timeout:15000,env:{...process.env,NOTALONE_SKILLS_DIR:files.root,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname}}));
 assert.deepEqual(use.execution_view,original);
 await assert.rejects(port.resource(scope,selected,catalog.revision,'references/sample.txt'),{code:'skill_unavailable'});
 await port.validateUseInTransaction(f.client,scope,catalog.revision,use);
 await f.client.query('UPDATE skill_scope_policy SET revision=2 WHERE owner_id=$1',[scope.ownerId]);
 await assert.rejects(port.validateUseInTransaction(f.client,scope,catalog.revision,use),{code:'reply_input_invalidated'});
});
test('旧Python联系人导航proof等价，联系人隔离且原来源撤销拒绝',async t=>{
 const {f,scope,entry}=await setup(t),source=randomUUID(),memory=randomUUID();
 await f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'wechat_jsonl','synthetic.jsonl',$4,0)",[source,scope.ownerId,scope.contactId,'a'.repeat(64)]);
 await f.client.query("INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,source_ids,adoption_method) VALUES($1,$2,$3,'合成联系人偏好','preference',$4,'manual')",[memory,scope.ownerId,scope.contactId,[source]]);
 const proof=pythonProof(f,scope,source,entry.versionId,memory,'contact');
 assert.deepEqual(await captureSkillNavigation(f.client,scope.ownerId,scope.contactId,proof.navigation.navigation.map(p=>p.identity)),proof.navigation.navigation);
 await requireReviewSources(f.client,scope.ownerId,scope.contactId,proof.navigation_deps,proof.navigation);
 await assert.rejects(requireReviewSources(f.client,scope.ownerId,randomUUID(),proof.navigation_deps,proof.navigation),{code:'skill_unavailable'});
 await f.client.query("UPDATE source_document SET status='deleting' WHERE id=$1",[source]);
 await assert.rejects(requireReviewSources(f.client,scope.ownerId,scope.contactId,proof.navigation_deps,proof.navigation),{code:'skill_unavailable'});
});
test('资源与清单同时被替换也不能覆盖本轮冻结的资源digest',async t=>{
 const {f,scope,port,catalog,entry,root}=await setup(t);await port.loadVersion(scope,entry,catalog.revision);await port.resource(scope,entry,catalog.revision,'references/sample.txt');
 const {readFile}=await import('node:fs/promises'),{createHash}=await import('node:crypto');
 const row=(await f.client.query('SELECT content_path FROM reply_skill_version WHERE id=$1',[entry.versionId])).rows[0],path=join(root,dirname(dirname(row.content_path)),'manifest.json');
 const manifest=JSON.parse(await readFile(path,'utf8')),bytes=Buffer.from('替换参考。');manifest.resources[0].content_sha256=createHash('sha256').update(bytes).digest('hex');manifest.resources[0].byte_size=bytes.length;
 const serialized=JSON.stringify(manifest);await writeFile(path,serialized);await writeFile(join(root,dirname(row.content_path),'references/sample.txt'),bytes);await writeFile(join(root,scope.ownerId,entry.name,'references/sample.txt'),bytes);
 await f.client.query('UPDATE reply_skill_version SET manifest_sha256=$2 WHERE id=$1',[entry.versionId,createHash('sha256').update(serialized).digest('hex')]);
 await assert.rejects(port.validateInTransaction(f.client,scope,catalog.revision,entry),{code:'reply_input_invalidated'});
});
test('讨论来源缺协议拒绝，注入核验失败不能被学习来源吞掉',async t=>{
 const {f,scope}=await setup(t),request=randomUUID();
 await f.client.query("INSERT INTO reply_request(id,owner_id,contact_id,conversation_binding_id,idempotency_key,normalized_input,state,attempt,lease_expires_at,context_snapshot,skill_library_revision) VALUES($1,$2,$3,$4,$5,'synthetic','completed',1,now(),$6,0)",[request,scope.ownerId,scope.contactId,randomUUID(),randomUUID(),{assistant_discussion_snapshot:{invalid:'synthetic'}}]);
 const proof=await captureSkillGeneration(f.client,scope.ownerId,scope.contactId,[request]);
 await assert.rejects(requireReviewSources(f.client,scope.ownerId,scope.contactId,[request],proof),{code:'skill_discussion_proof_unavailable'});
 let seen=false;
 await assert.rejects(requireReviewSources(f.client,scope.ownerId,scope.contactId,[request],proof,{checking:new Set(),validated:new Set(),requireDiscussionDependencies:async(client,owner,contact,id)=>{assert.equal(client,f.client);assert.equal(owner,scope.ownerId);assert.equal(contact,scope.contactId);assert.equal(id,request);seen=true;throw Error('synthetic_invalid_discussion');}}),{code:'skill_unavailable'});
 assert.equal(seen,true);
});
