import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,access} from 'node:fs/promises';
import {join} from 'node:path';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {HostStorage} from '../src/platform/database/host-storage.ts';
import {SkillLibrary} from '../src/skills/skill-library.ts';
import {SkillFiles} from '../src/skills/skill-files.ts';
import {queueSkillFileCleanup,cleanupSkillFiles} from '../src/skills/skill-cleanup.ts';
test('文件清理先入队且回滚不删文件，提交后按owner擦除并幂等重试',async t=>{
 const f=await createStorageFixture();t.after(()=>f.close());const storage=await HostStorage.open(f.options);t.after(()=>storage.close());await storage.initializeOwner('合成');
 const files=new SkillFiles(join(f.directory,'skills')),library=new SkillLibrary(storage,files),path=join(f.directory,'clean-skill');await mkdir(path);await writeFile(join(path,'SKILL.md'),'---\nname: clean-skill\ndescription: "合成"\n---\n\n合成正文');
 const item=await library.handle('POST',new URL('http://local/api/skills/import'),{package_path:path});
 const owner=storage.runtimeOwnerId,working=join(f.directory,'skills',owner,'clean-skill');
 await f.client.query('BEGIN');await queueSkillFileCleanup(f.client,item.skill_id);await f.client.query('ROLLBACK');await access(working);
 assert.equal(await cleanupSkillFiles(f.client,owner,files),0);
 await f.client.query('BEGIN');await queueSkillFileCleanup(f.client,item.skill_id);await f.client.query('COMMIT');await access(working);
 assert.equal(await cleanupSkillFiles(f.client,'00000000-0000-4000-8000-000000000099',files),0);
 assert.equal(await cleanupSkillFiles(f.client,owner,files),3);await assert.rejects(access(working));assert.equal(await cleanupSkillFiles(f.client,owner,files),0);
});
test('删除依赖清空合成草稿与审核正文，其他owner保留且重复删除幂等',async t=>{
 const {randomUUID}=await import('node:crypto');const {eraseSkillLearning}=await import('../src/skills/skill-cleanup.ts');
 const f=await createStorageFixture();t.after(()=>f.close());const removed=randomUUID(),owners=[];
 for(let i=0;i<2;i++){
  const owner=randomUUID(),contact=randomUUID(),draft=randomUUID(),comparison=randomUUID();owners.push({owner,draft,comparison});
  await f.client.query('INSERT INTO owner(id,display_name) VALUES($1,$2)',[owner,'合成用户']);await f.client.query('INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,$3)',[contact,owner,'合成联系人']);
  await f.client.query("INSERT INTO skill_draft(id,owner_id,contact_id,logical_skill_id,proposal_kind,strategy,private_evidence,dependency_ids,batch_key) VALUES($1,$2,$3,$4,'create','{\"text\":\"策略\"}','{\"text\":\"合成依据\"}',$5,'batch')",[draft,owner,contact,randomUUID(),[removed]]);
  await f.client.query("INSERT INTO skill_review_comparison(id,owner_id,contact_id,draft_id,draft_revision,input_version,input,library_revision,dependency_ids,state,result) VALUES($1,$2,$3,$4,1,$5,'{\"text\":\"合成输入\"}',0,$6,'completed','{\"text\":\"合成结果\"}')",[comparison,owner,contact,draft,randomUUID(),[removed]]);
 }
 await f.client.query('BEGIN');await eraseSkillLearning(f.client,owners[0].owner,[removed]);await f.client.query('COMMIT');
 for(const [i,row] of owners.entries()){
  const draft=(await f.client.query('SELECT status,strategy,private_evidence FROM skill_draft WHERE id=$1',[row.draft])).rows[0];
  const comparison=(await f.client.query('SELECT state,input,result FROM skill_review_comparison WHERE id=$1',[row.comparison])).rows[0];
  assert.equal(draft.status,i?'pending':'invalidated');assert.equal(comparison.state,i?'completed':'invalidated');
  if(!i){assert.equal(draft.strategy,null);assert.equal(draft.private_evidence,null);assert.equal(comparison.input,null);assert.equal(comparison.result,null);}
 }
 await eraseSkillLearning(f.client,owners[0].owner,[removed]);
});
test('文件擦除失败保留队列供重试，不误报完成',async t=>{
 const f=await createStorageFixture();t.after(()=>f.close());const owner='00000000-0000-4000-8000-000000000010',path=owner+'/synthetic';
 await f.client.query('INSERT INTO reply_skill_file_cleanup(relative_path) VALUES($1)',[path]);
 assert.equal(await cleanupSkillFiles(f.client,owner,{remove(){throw Error('合成失败');}}),0);
 const seen=[];assert.equal(await cleanupSkillFiles(f.client,owner,{remove(value){seen.push(value);}}),1);assert.deepEqual(seen,[path]);
});
test('审核发布撤销必须同事务清理使用回复，缺少依赖则回滚，版本文件在提交后擦除',async t=>{
 const {randomUUID}=await import('node:crypto');const {eraseSkillLearning}=await import('../src/skills/skill-cleanup.ts');
 const f=await createStorageFixture();t.after(()=>f.close());const storage=await HostStorage.open(f.options);t.after(()=>storage.close());await storage.initializeOwner('合成');
 const files=new SkillFiles(join(f.directory,'skills')),library=new SkillLibrary(storage,files),path=join(f.directory,'published-skill');await mkdir(path);await writeFile(join(path,'SKILL.md'),'---\nname: published-skill\ndescription: "合成"\n---\n\n合成正文');
 const item=await library.handle('POST',new URL('http://local/api/skills/import'),{package_path:path});
 const owner=storage.runtimeOwnerId,contact=randomUUID(),draft=randomUUID(),removed=randomUUID();
 const version=(await f.client.query('SELECT id FROM reply_skill_version WHERE skill_id=$1',[item.skill_id])).rows[0].id;
 await f.client.query('INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,$3)',[contact,owner,'合成联系人']);
 await f.client.query("INSERT INTO skill_draft(id,owner_id,contact_id,logical_skill_id,proposal_kind,status,dependency_ids,batch_key) VALUES($1,$2,$3,$4,'create','published',$5,'batch')",[draft,owner,contact,item.skill_id,[removed]]);
 await f.client.query('UPDATE reply_skill_version SET review_origin=true WHERE id=$1',[version]);
 await f.client.query("INSERT INTO reply_skill_publication(version_id,owner_id,origin_contact_id,draft_id,logical_skill_id,scope_kind,dependency_ids) VALUES($1,$2,$3,$4,$5,'owner',$6)",[version,owner,contact,draft,item.skill_id,[removed]]);
 await f.client.query('BEGIN');await assert.rejects(eraseSkillLearning(f.client,owner,[removed]),/skill_reply_cleanup_required/);await f.client.query('ROLLBACK');
 assert.equal((await f.client.query('SELECT status FROM skill_draft WHERE id=$1',[draft])).rows[0].status,'published');
 await f.client.query('BEGIN');await assert.rejects(eraseSkillLearning(f.client,owner,[removed],async()=>{throw Error('synthetic_reply_failure');}),/synthetic_reply_failure/);await f.client.query('ROLLBACK');
 assert.equal((await f.client.query('SELECT deleted FROM reply_skill_publication WHERE version_id=$1',[version])).rows[0].deleted,false);
 assert.equal((await f.client.query('SELECT count(*)::int AS n FROM reply_skill_file_cleanup')).rows[0].n,0);
 const calls=[];await f.client.query('BEGIN');await eraseSkillLearning(f.client,owner,[removed],async(client,input)=>{assert.equal(client,f.client);calls.push(input);});await f.client.query('COMMIT');
 assert.deepEqual(calls,[{ownerId:owner,contactId:null,removedIds:[version],revokeRunningScope:false}]);
 const row=(await f.client.query('SELECT status,content_path,enabled FROM reply_skill_version WHERE id=$1',[version])).rows[0];assert.deepEqual(row,{status:'deleted',content_path:null,enabled:false});
 assert.equal((await f.client.query('SELECT deleted FROM reply_skill_publication WHERE version_id=$1',[version])).rows[0].deleted,true);
 assert.equal(await cleanupSkillFiles(f.client,owner,files),3);
});

test('同事务回复删除端口可递归撤销另一联系人的派生发布，且重复撤销不复活',async t=>{
 const {randomUUID}=await import('node:crypto');const {eraseSkillLearning}=await import('../src/skills/skill-cleanup.ts');
 const f=await createStorageFixture();t.after(()=>f.close());const storage=await HostStorage.open(f.options);t.after(()=>storage.close());await storage.initializeOwner('合成');
 const files=new SkillFiles(join(f.directory,'skills')),library=new SkillLibrary(storage,files),owner=storage.runtimeOwnerId,source=randomUUID(),rows=[];
 for(const name of ['parent-skill','derived-skill']){
  const path=join(f.directory,name);await mkdir(path);await writeFile(join(path,'SKILL.md'),`---\nname: ${name}\ndescription: "合成"\n---\n\n合成正文`);
  const item=await library.handle('POST',new URL('http://local/api/skills/import'),{package_path:path});
  const version=(await f.client.query('SELECT id FROM reply_skill_version WHERE skill_id=$1',[item.skill_id])).rows[0].id;
  const contact=randomUUID(),draft=randomUUID(),dependency=rows.length?rows[0].version:source;
  await f.client.query('INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,$3)',[contact,owner,'合成联系人']);
  await f.client.query("INSERT INTO skill_draft(id,owner_id,contact_id,logical_skill_id,proposal_kind,status,dependency_ids,batch_key) VALUES($1,$2,$3,$4,'create','published',$5,$6)",[draft,owner,contact,item.skill_id,[dependency],name]);
  await f.client.query('UPDATE reply_skill_version SET review_origin=true WHERE id=$1',[version]);
  await f.client.query("INSERT INTO reply_skill_publication(version_id,owner_id,origin_contact_id,draft_id,logical_skill_id,scope_kind,dependency_ids) VALUES($1,$2,$3,$4,$5,'owner',$6)",[version,owner,contact,draft,item.skill_id,[dependency]]);
  rows.push({version,contact,draft});
 }
 const seen=[];
 const deletion=async(client,input)=>{assert.equal(client,f.client);assert.equal(input.contactId,null);assert.equal(input.revokeRunningScope,false);seen.push(...input.removedIds);await eraseSkillLearning(client,input.ownerId,input.removedIds,deletion);};
 await f.client.query('BEGIN');await eraseSkillLearning(f.client,owner,[source],deletion);await f.client.query('COMMIT');
 assert.deepEqual(seen,rows.map(r=>r.version));
 assert.equal((await f.client.query("SELECT count(*)::int AS n FROM reply_skill_publication WHERE owner_id=$1 AND deleted",[owner])).rows[0].n,2);
 assert.equal((await f.client.query("SELECT count(*)::int AS n FROM skill_draft WHERE owner_id=$1 AND status='invalidated'",[owner])).rows[0].n,2);
 await eraseSkillLearning(f.client,owner,[source],deletion);assert.equal(seen.length,2);
 assert.equal(await cleanupSkillFiles(f.client,owner,files),6);
});

test('失败发布的隐藏快照按owner回收，合法历史及有待办的暂存保留，回滚不擦文件',async t=>{
 const {randomUUID}=await import('node:crypto');const {readPackage}=await import('../src/skills/skill-package.ts');const {cleanupUnreferencedSkillSnapshots}=await import('../src/skills/skill-cleanup.ts');
 const f=await createStorageFixture();t.after(()=>f.close());const storage=await HostStorage.open(f.options);t.after(()=>storage.close());await storage.initializeOwner('合成');
 const root=join(f.directory,'skills'),files=new SkillFiles(root),library=new SkillLibrary(storage,files),path=join(f.directory,'retained-skill');await mkdir(path);await writeFile(join(path,'SKILL.md'),'---\nname: retained-skill\ndescription: "合成"\n---\n\n合成正文');
 const item=await library.handle('POST',new URL('http://local/api/skills/import'),{package_path:path}),owner=storage.runtimeOwnerId,pkg=readPackage(path);
 const row=(await f.client.query('SELECT id,content_path FROM reply_skill_version WHERE skill_id=$1',[item.skill_id])).rows[0];
 const historical=randomUUID(),historicalReceipt=files.prepareVersion(owner,item.skill_id,historical,pkg);
 await f.client.query("INSERT INTO reply_skill_version(id,skill_id,version_number,content_sha256,source_locator,enabled,is_current,status,content_path,document_sha256,manifest_sha256) VALUES($1,$2,2,$3,'synthetic',false,false,'active',$4,$5,$6)",[historical,item.skill_id,historicalReceipt.content_sha256,historicalReceipt.content_path,historicalReceipt.document_sha256,historicalReceipt.manifest_sha256]);
 const orphan=randomUUID(),otherOwner=randomUUID(),otherSkill=randomUUID(),otherVersion=randomUUID();
 const orphanReceipt=files.prepareVersion(owner,item.skill_id,orphan,pkg),otherReceipt=files.prepareVersion(otherOwner,otherSkill,otherVersion,pkg);
 await f.client.query('INSERT INTO reply_skill_working_copy(skill_id,version_id) VALUES($1,$2)',[item.skill_id,row.id]);
 await f.client.query('BEGIN');await cleanupUnreferencedSkillSnapshots(f.client,owner,files);await f.client.query('ROLLBACK');
 await access(join(root,orphanReceipt.content_path));assert.equal((await f.client.query('SELECT count(*)::int AS n FROM reply_skill_file_cleanup')).rows[0].n,0);
 await f.client.query('BEGIN');await cleanupUnreferencedSkillSnapshots(f.client,owner,files);await f.client.query('COMMIT');
 const queued=(await f.client.query('SELECT relative_path FROM reply_skill_file_cleanup')).rows.map(r=>r.relative_path);
 assert.deepEqual(queued,[`.versions/${owner}/${item.skill_id}/${orphan}`]);
 await cleanupSkillFiles(f.client,owner,files);await assert.rejects(access(join(root,orphanReceipt.content_path)));await access(join(root,row.content_path));await access(join(root,otherReceipt.content_path));await access(join(root,historicalReceipt.content_path));
 await access(join(root,`.staging/${owner}/${item.skill_id}`));
 await f.client.query('DELETE FROM reply_skill_working_copy WHERE skill_id=$1',[item.skill_id]);
 await cleanupUnreferencedSkillSnapshots(f.client,owner,files);await cleanupSkillFiles(f.client,owner,files);await assert.rejects(access(join(root,`.staging/${owner}/${item.skill_id}`)));await access(join(root,row.content_path));
 await f.client.query("UPDATE reply_skill_version SET status='deleted',deleted_at=now(),content_path=NULL,document_sha256=NULL,manifest_sha256=NULL,content_sha256=NULL,source_locator=NULL WHERE id=$1",[historical]);
 await cleanupUnreferencedSkillSnapshots(f.client,owner,files);await cleanupSkillFiles(f.client,owner,files);await assert.rejects(access(join(root,historicalReceipt.content_path)));await access(join(root,row.content_path));
});

test('来源删除擦除学习批次摘要并取消未完成步骤，已成功步骤和其他owner不动',async t=>{
 const {randomUUID}=await import('node:crypto');const {eraseSkillLearning}=await import('../src/skills/skill-cleanup.ts');const f=await createStorageFixture();t.after(()=>f.close());const removed=randomUUID(),rows=[];
 for(let i=0;i<2;i++){
  const owner=randomUUID(),contact=randomUUID(),task=randomUUID(),batch=randomUUID();rows.push({owner,contact,task,batch});
  await f.client.query('INSERT INTO owner(id,display_name) VALUES($1,$2)',[owner,'合成']);await f.client.query('INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,$3)',[contact,owner,'合成']);
  await f.client.query("INSERT INTO background_task(id,owner_id,contact_id,task_type,status,current_step,message_count) VALUES($1,$2,$3,'skill_learning','running','propose_skill',1)",[task,owner,contact]);
  for(const [step,status] of [['propose_skill','running'],['verify_skill_drafts','succeeded']])await f.client.query('INSERT INTO background_task_step(task_id,step_name,status,step_order) VALUES($1,$2,$3,$4)',[task,step,status,step==='propose_skill'?1:2]);
  await f.client.query("INSERT INTO skill_learning_scope(owner_id,contact_id,enabled,last_attempt_key) VALUES($1,$2,true,'attempt')",[owner,contact]);
  await f.client.query("INSERT INTO skill_learning_batch(id,owner_id,contact_id,task_id,batch_key,outcome,dependency_ids) VALUES($1,$2,$3,$4,'batch','no_change',$5)",[batch,owner,contact,task,[removed]]);
  await f.client.query("INSERT INTO skill_learning_receipt(owner_id,contact_id,material_id,digest,batch_id) VALUES($1,$2,$3,'synthetic',$4)",[owner,contact,removed,batch]);
 }
 await f.client.query('BEGIN');await eraseSkillLearning(f.client,rows[0].owner,[removed]);await f.client.query('COMMIT');
 for(const [index,row] of rows.entries()){
  assert.equal((await f.client.query('SELECT status FROM background_task WHERE id=$1',[row.task])).rows[0].status,index?'running':'cancelled');
  assert.deepEqual((await f.client.query('SELECT status FROM background_task_step WHERE task_id=$1 ORDER BY step_name',[row.task])).rows.map(r=>r.status),[index?'running':'cancelled','succeeded']);
  assert.equal((await f.client.query('SELECT digest FROM skill_learning_receipt WHERE batch_id=$1',[row.batch])).rows[0].digest,index?'synthetic':null);
  assert.equal((await f.client.query('SELECT last_attempt_key FROM skill_learning_scope WHERE owner_id=$1',[row.owner])).rows[0].last_attempt_key,index?'attempt':null);
 }
});
