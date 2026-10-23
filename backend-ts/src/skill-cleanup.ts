/** 删除闭包：数据库撤资格与文件擦除分阶段执行；不运行学习生产流程。 */
import type pg from 'pg';
import type {SkillFiles} from './skill-files.ts';
export type DeleteSkillReplies=(client:pg.Client,input:{ownerId:string;contactId:null;removedIds:string[];revokeRunningScope:false})=>Promise<void>;
export async function queueSkillFileCleanup(client:pg.Client,skillId:string,versionIds?:readonly string[]):Promise<void>{
 const skill=(await client.query('SELECT owner_id,name FROM public.reply_skill WHERE id=$1',[skillId])).rows[0];if(!skill)return;
 const versions=(await client.query('SELECT id,is_current FROM public.reply_skill_version WHERE skill_id=$1',[skillId])).rows.filter(v=>!versionIds||versionIds.includes(v.id));
 const paths=versionIds?versions.map(v=>`.versions/${skill.owner_id}/${skillId}/${v.id}`):[`.versions/${skill.owner_id}/${skillId}`];
 paths.push(`.staging/${skill.owner_id}/${skillId}`);
 if(!versionIds||versions.some(v=>v.is_current)){paths.push(`${skill.owner_id}/${skill.name}`);await client.query('DELETE FROM public.reply_skill_working_copy WHERE skill_id=$1',[skillId]);}
 for(const path of paths)await client.query('INSERT INTO public.reply_skill_file_cleanup(relative_path) VALUES($1) ON CONFLICT DO NOTHING',[path]);
 if(versions.length)await client.query('UPDATE public.reply_skill_version SET method_manifest_path=NULL,method_manifest_sha256=NULL WHERE id=ANY($1::uuid[])',[versions.map(v=>v.id)]);
}
/** 调用者在撤资格事务提交后开启独立事务并持有 owner 锁。 */
export async function cleanupSkillFiles(client:pg.Client,owner:string,files:Pick<SkillFiles,'remove'>):Promise<number>{
 const rows=(await client.query('SELECT relative_path FROM public.reply_skill_file_cleanup WHERE relative_path LIKE $1 OR relative_path LIKE $2 OR relative_path LIKE $3 FOR UPDATE',[`${owner}/%`,`.versions/${owner}/%`,`.staging/${owner}/%`])).rows;
 let count=0;
 for(const row of rows){
  try{files.remove(row.relative_path);}catch{continue;}
  await client.query('DELETE FROM public.reply_skill_file_cleanup WHERE relative_path=$1',[row.relative_path]);count++;
 }
 return count;
}
export async function invalidateSkillComparisons(client:pg.Client,owner:string,drafts:readonly string[]):Promise<void>{
 await client.query("UPDATE public.skill_review_comparison SET state='invalidated',input=NULL,confirmed_scope=NULL,context_fingerprint=NULL,dependency_ids='{}',source_generation='{}',target_versions='[]',result=NULL,run_token=NULL,lease_expires_at=NULL WHERE owner_id=$1 AND draft_id=ANY($2::uuid[])",[owner,drafts]);
 await client.query("UPDATE public.skill_review_operation SET request_fingerprint=NULL WHERE owner_id=$1 AND draft_id=ANY($2::uuid[]) AND action='compare'",[owner,drafts]);
}
export async function eraseSkillReviewArtifacts(client:pg.Client,owner:string,drafts:readonly string[],deleteReplies?:DeleteSkillReplies):Promise<void>{
 if(!(await client.query("SELECT to_regclass('public.skill_review_comparison') AS relation")).rows[0].relation)return;
 await invalidateSkillComparisons(client,owner,drafts);
 const rows=(await client.query('SELECT publication.version_id,version.skill_id,version.is_current FROM public.reply_skill_publication publication JOIN public.reply_skill_version version ON version.id=publication.version_id WHERE publication.owner_id=$1 AND publication.draft_id=ANY($2::uuid[]) AND version.review_origin AND NOT publication.deleted',[owner,drafts])).rows;
 // 缺少回复领域删除依赖时必须由外层事务回滚，不能漏掉已使用版本的历史正文。
 if(rows.length&&!deleteReplies)throw Error('skill_reply_cleanup_required');
 await client.query("UPDATE public.reply_skill_publication SET deleted=true,dependency_ids='{}',source_generation='{}',scope_kind='owner',scope_contact_id=NULL,scene=NULL WHERE owner_id=$1 AND draft_id=ANY($2::uuid[])",[owner,drafts]);
 await client.query('UPDATE public.skill_review_operation SET request_fingerprint=NULL WHERE owner_id=$1 AND draft_id=ANY($2::uuid[])',[owner,drafts]);
 await client.query('UPDATE public.skill_draft SET current_comparison_id=NULL WHERE owner_id=$1 AND id=ANY($2::uuid[])',[owner,drafts]);
 if(!rows.length)return;
 for(const skill of new Set<string>(rows.map(r=>r.skill_id)))await queueSkillFileCleanup(client,skill,rows.filter(r=>r.skill_id===skill).map(r=>r.version_id));
 const versions=rows.map(r=>r.version_id);
 await client.query("UPDATE public.reply_skill_version SET content_path=NULL,document_sha256=NULL,manifest_sha256=NULL,method_manifest_path=NULL,method_manifest_sha256=NULL,content_sha256=NULL,source_locator=NULL,enabled=false,is_current=false,status='deleted',deleted_at=now() WHERE id=ANY($1::uuid[])",[versions]);
 await client.query("UPDATE public.reply_skill SET status='disabled',updated_at=now() WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND status<>'deleted'",[owner,rows.filter(r=>r.is_current).map(r=>r.skill_id)]);
 await client.query('UPDATE public.skill_library SET revision=revision+1,updated_at=now() WHERE owner_id=$1',[owner]);
 await deleteReplies!(client,{ownerId:owner,contactId:null,removedIds:versions,revokeRunningScope:false});
}
async function eraseDigests(client:pg.Client,owner:string,batches:string[]){await client.query('UPDATE public.skill_learning_receipt SET digest=NULL WHERE owner_id=$1 AND batch_id=ANY($2::uuid[])',[owner,batches]);}
async function invalidateDrafts(client:pg.Client,owner:string,drafts:string[],deleteReplies?:DeleteSkillReplies){
 if(!drafts.length)return;
 await client.query("UPDATE public.skill_draft SET status='invalidated',revision=revision+1,strategy=NULL,private_evidence=NULL,target_versions='[]',dependency_ids='{}',source_generation='{}',batch_key=id::text WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND status<>'invalidated'",[owner,drafts]);
 await eraseSkillReviewArtifacts(client,owner,drafts,deleteReplies);
 const batches=(await client.query("UPDATE public.skill_learning_batch SET outcome='invalidated',dependency_ids='{}',batch_key=id::text WHERE owner_id=$1 AND draft_id=ANY($2::uuid[]) RETURNING id",[owner,drafts])).rows;
 await eraseDigests(client,owner,batches.map(r=>r.id));
}
export async function eraseSkillLearning(client:pg.Client,owner:string,removedIds:readonly string[],deleteReplies?:DeleteSkillReplies):Promise<void>{
 if(!(await client.query("SELECT to_regclass('public.skill_draft') AS relation")).rows[0].relation)return;
 if((await client.query("SELECT to_regclass('public.skill_review_comparison') AS relation")).rows[0].relation){
  const affected=(await client.query("SELECT DISTINCT draft_id FROM public.skill_review_comparison WHERE owner_id=$1 AND dependency_ids && $2::uuid[] AND state<>'invalidated'",[owner,removedIds])).rows.map(r=>r.draft_id);
  await invalidateSkillComparisons(client,owner,affected);
  await client.query('UPDATE public.skill_draft SET current_comparison_id=NULL WHERE owner_id=$1 AND id=ANY($2::uuid[])',[owner,affected]);
  const published=(await client.query('SELECT draft_id FROM public.reply_skill_publication WHERE owner_id=$1 AND NOT deleted AND (dependency_ids && $2::uuid[] OR version_id=ANY($2::uuid[]) OR logical_skill_id=ANY($2::uuid[]))',[owner,removedIds])).rows;
  await invalidateDrafts(client,owner,published.map(r=>r.draft_id),deleteReplies);
 }
 const drafts=(await client.query("SELECT id,contact_id FROM public.skill_draft WHERE owner_id=$1 AND dependency_ids && $2::uuid[] AND status<>'invalidated'",[owner,removedIds])).rows;
 await invalidateDrafts(client,owner,drafts.map(r=>r.id),deleteReplies);
 const batches=(await client.query("UPDATE public.skill_learning_batch SET outcome='invalidated',dependency_ids='{}',batch_key=id::text WHERE owner_id=$1 AND dependency_ids && $2::uuid[] RETURNING id,contact_id",[owner,removedIds])).rows;
 await eraseDigests(client,owner,batches.map(r=>r.id));
 for(const contact of new Set([...drafts,...batches].map(r=>r.contact_id))){
  await client.query("UPDATE public.background_task_step SET status='cancelled',worker_id=NULL,lease_expires_at=NULL WHERE task_id IN (SELECT id FROM public.background_task WHERE owner_id=$1 AND contact_id=$2 AND task_type='skill_learning') AND status<>'succeeded'",[owner,contact]);
  await client.query("UPDATE public.background_task SET status='cancelled',observation_pending=false WHERE owner_id=$1 AND contact_id=$2 AND task_type='skill_learning' AND status IN ('queued','running','verifying','failed')",[owner,contact]);
  await client.query('UPDATE public.skill_learning_scope SET last_attempt_key=NULL WHERE owner_id=$1 AND contact_id=$2',[owner,contact]);
 }
}

/** 调用方持有业务事务；只登记隐藏残留，不扫描或删除用户工作目录。 */
export async function cleanupUnreferencedSkillSnapshots(client:pg.Client,owner:string,files:Pick<SkillFiles,'scanSnapshotDirectories'|'scanStagingDirectories'>):Promise<void>{
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${owner}`]);
 for(const entry of files.scanSnapshotDirectories(owner)){
  const row=(await client.query('SELECT version.content_path,version.status FROM public.reply_skill_version version JOIN public.reply_skill skill ON skill.id=version.skill_id WHERE skill.owner_id=$1 AND version.skill_id=$2 AND version.id=$3',[owner,entry.skill_id,entry.version_id])).rows[0];
  if(row?.status!=='deleted'&&typeof row?.content_path==='string'&&row.content_path.startsWith(entry.relative_path+'/'))continue;
  await client.query('INSERT INTO public.reply_skill_file_cleanup(relative_path) VALUES($1) ON CONFLICT DO NOTHING',[entry.relative_path]);
 }
 for(const entry of files.scanStagingDirectories(owner)){
  const pending=await client.query('SELECT 1 FROM public.reply_skill_working_copy pending JOIN public.reply_skill skill ON skill.id=pending.skill_id WHERE skill.owner_id=$1 AND skill.id=$2',[owner,entry.skill_id]);
  if(!pending.rowCount)await client.query('INSERT INTO public.reply_skill_file_cleanup(relative_path) VALUES($1) ON CONFLICT DO NOTHING',[entry.relative_path]);
 }
}
