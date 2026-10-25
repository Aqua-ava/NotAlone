/** 合成资料的版本与来源绑定；不写真实库。 */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {HostStorage} from '../../../backend-ts/src/host-storage.ts';
import {SkillLibrary} from '../../../backend-ts/src/skill-library.ts';
import {SkillFiles} from '../../../backend-ts/src/skill-files.ts';
export async function seedExistingSkill(f,run,owned){
  const frozen=owned.adaptation.existing_skill;
  if(!frozen)return;
  const packageRoot=join(f.directory,'frozen-existing-method'),filesRoot=join(f.directory,'skills');
  await mkdir(packageRoot,{mode:0o700});await mkdir(filesRoot,{mode:0o700});
  await writeFile(join(packageRoot,'SKILL.md'),`---\nname: frozen-existing-method\ndescription: "当前联系人已启用的方法"\n---\n\n${frozen.method}`,{mode:0o600});
  const storage=await HostStorage.open(f.options);
  try{
    const library=new SkillLibrary(storage,new SkillFiles(filesRoot));
    await library.importPackage(run.scope.owner_id,packageRoot);
    const row=(await f.client.query(`SELECT skill.id AS skill_id,version.id AS version_id,version.version_number,
      version.enabled,version.is_current,version.content_sha256 FROM reply_skill skill JOIN reply_skill_version version
      ON version.skill_id=skill.id WHERE skill.owner_id=$1`,[run.scope.owner_id])).rows[0];
    assert.equal(row.version_number,frozen.version);assert.equal(row.enabled,frozen.enabled);
    await f.client.query('UPDATE reply_skill SET contact_id=$2 WHERE id=$1',[row.skill_id,run.scope.contact_id]);
    // 初始夹具范围映射单独记录，不将资料搬入全局或伪造审核发布。
    Object.assign(frozen,{storage_skill_id:row.skill_id,storage_version_id:row.version_id,content_sha256:row.content_sha256,
      binding:'frozen_contact_scoped_existing_import',is_current:row.is_current});
    owned.skillFilesRoot=filesRoot;owned.skillBefore=await skillVersions(f,run);
  }finally{await storage.close();}
}
export async function skillVersions(f,run){
  return (await f.client.query(`SELECT skill.id,skill.contact_id,skill.status,version.id AS version_id,
    version.version_number,version.enabled,version.is_current,version.content_sha256 FROM reply_skill skill
    JOIN reply_skill_version version ON version.skill_id=skill.id WHERE skill.owner_id=$1 ORDER BY skill.id,version.version_number`,
  [run.scope.owner_id])).rows;
}
export async function finalState(f,run,owned){
  const scope=[run.scope.owner_id,run.scope.contact_id];
  const counts={};
  for(const table of ['scenario_document_version','layered_profile_version','skill_draft']){
    const result=await f.client.query('SELECT to_regclass($1) AS name',[`public.${table}`]);
    counts[table]=result.rows[0].name?(await f.client.query(`SELECT count(*)::int AS n FROM ${table} WHERE owner_id=$1 AND contact_id=$2`,scope)).rows[0].n:null;
  }
  const versions=await skillVersions(f,run);
  return {counts,skill_versions:versions,existing_skill_unchanged:JSON.stringify(versions)===JSON.stringify(owned.skillBefore??[]),
    draft_states:(await f.client.query('SELECT status,target_versions,dependency_ids FROM skill_draft WHERE owner_id=$1 AND contact_id=$2 ORDER BY created_at',scope)).rows,
    actual_sources:(await f.client.query('SELECT id,status,content_sha256 FROM source_document WHERE owner_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',
      [run.scope.owner_id,owned.adaptation.sources.map(s=>s.storage_id)])).rows,
    actual_memory_versions:(await f.client.query('SELECT id,revision,source_ids,status FROM confirmed_memory WHERE owner_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',
      [run.scope.owner_id,owned.adaptation.sources.map(s=>s.memory_id)])).rows,
    frozen_projection_absence:owned.adaptation.existing_projection===null,
    source_versions:owned.adaptation.sources.map(s=>({source_id:s.source_id,version:s.version,state:s.state,
      storage_id:s.storage_id,memory_id:s.memory_id,message_id:s.message_id,speaker:s.speaker,
      corrects_source_ids:s.corrects_source_ids})),
    task_states:(await f.client.query('SELECT status FROM background_task WHERE owner_id=$1 AND contact_id=$2 ORDER BY created_at',scope)).rows};
}
