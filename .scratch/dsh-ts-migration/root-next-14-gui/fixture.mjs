import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStorageFixture } from '../../../backend-ts/test/host-storage-fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const python = path.join(homedir(), 'miniconda3/envs/NotAlone/bin/python');
const statePath = '/tmp/notalone-l3-gui-state.json';
const command = process.argv[2];

async function state() {
  return JSON.parse(await readFile(statePath, 'utf8'));
}

async function cleanup() {
  const current = await state();
  if (!String(current.database).startsWith('notalone_ts_host_') || !String(current.database).endsWith('_test')) {
    throw new Error('refusing temporary database cleanup');
  }
  execFileSync(python, ['-c', `
import psycopg
from psycopg import sql
with psycopg.connect('host=/tmp dbname=postgres user=wye', autocommit=True) as connection:
    connection.execute(sql.SQL('DROP DATABASE IF EXISTS {}').format(sql.Identifier('${current.database}')))
`], { stdio: 'pipe' });
  await rm(current.directory, { recursive: true, force: true });
  await rm(statePath, { force: true });
}

async function setup() {
  if (await readFile(statePath, 'utf8').catch(() => null)) throw new Error('isolated GUI fixture already exists');
  const fixture = await createStorageFixture();
  const owner = randomUUID();
  const contact = randomUUID();
  const message1 = randomUUID();
  const message2 = randomUUID();
  const source1 = randomUUID();
  const source2 = randomUUID();
  const memory1 = randomUUID();
  const memory2 = randomUUID();
  const ownerMemory1 = randomUUID();
  const ownerMemory2 = randomUUID();
  const task = randomUUID();
  const scenarioBatch = randomUUID();
  const scenarioId = randomUUID();
  const scenarioVersion = randomUUID();
  const profileBatch = randomUUID();
  const profileVersion = randomUUID();
  const timing = {
    recorded_at:'2026-10-25T07:20:00+08:00',
    source_started_at:'2026-10-01T09:00:00+08:00',
    source_ended_at:'2026-10-01T09:00:00+08:00',
    source_time_complete:true,
    current_status:'current_unverified',
    current_status_reason:'合成桌面验收资料，不声明当前状态。',
  };
  const manifest = [
    {memory_id:ownerMemory1, revision:1},
    {memory_id:ownerMemory2, revision:1},
  ];
  const references = [ownerMemory1, ownerMemory2].map(memory_id => ({
    memory_id, revision:1, level:'contact', provenance_kind:'source_supported',
    valid_at:null, invalid_at:null, event:null, evolution:null, conditions:null, timing,
  }));
  const profileEntries = [{
    kind:'fact',
    section:'basic_information',
    temporal_status:'historical',
    text:'合成长期背景：两位测试对象共同参加过一次桌面验收课程。',
    basis:'合成底层记忆直接支持',
    uncertainty:'',
    references:[references[0]],
  }, {
    kind:'preference',
    section:'interests',
    temporal_status:'stable',
    text:'合成长期背景：测试对象偏好清淡食物。',
    basis:'合成底层记忆直接支持',
    uncertainty:'',
    references:[references[1]],
  }];
  await fixture.client.query('BEGIN');
  try {
    await fixture.client.query("INSERT INTO public.owner(id,display_name) VALUES($1,'合成L3桌面验收本人')", [owner]);
    await fixture.client.query("INSERT INTO public.contact(id,owner_id,display_name) VALUES($1,$2,'合成L3桌面验收联系人')", [contact, owner]);
    for (const [source, hash, fileName] of [
      [source1, 'a'.repeat(64), 'synthetic-l3-a.jsonl'],
      [source2, 'b'.repeat(64), 'synthetic-l3-b.jsonl'],
    ]) {
      await fixture.client.query(
        "INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'manual',$4,$5,1)",
        [source, owner, contact, fileName, hash],
      );
    }
    for (const [message, source, text] of [
      [message1, source1, '合成消息：共同参加过一次桌面验收课程。'],
      [message2, source2, '合成消息：偏好清淡食物。'],
    ]) {
      await fixture.client.query(
        "INSERT INTO public.message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES($1,$2,$3,'contact','text',$4,'2026-10-01T01:00:00Z')",
        [message, owner, contact, text],
      );
      await fixture.client.query(
        "INSERT INTO public.message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES($1,$2,$3,'source_document',$4,'line:1',$5)",
        [message, owner, contact, source, {time_iso:'2026-10-01T01:00:00+00:00', synthetic:true}],
      );
    }
    await fixture.client.query(
      "INSERT INTO public.confirmed_memory(id,owner_id,contact_id,text_content,category,source_ids,adoption_method,topic) VALUES($1,$2,$3,'合成资料：共同参加过一次桌面验收课程。','common_fact',$4,'manual','study')",
      [memory1, owner, contact, [source1]],
    );
    await fixture.client.query(
      "INSERT INTO public.confirmed_memory(id,owner_id,contact_id,text_content,category,source_ids,adoption_method,topic) VALUES($1,$2,$3,'合成资料：偏好清淡食物。','preference',$4,'manual','health')",
      [memory2, owner, contact, [source2]],
    );
    await fixture.client.query(
      "INSERT INTO public.owner_memory(id,owner_id,text_content,category,topic,source_ids,adoption_method) VALUES($1,$2,'合成本人资料：共同参加过一次桌面验收课程。','common_fact','study',$3,'manual')",
      [ownerMemory1, owner, [owner]],
    );
    await fixture.client.query(
      "INSERT INTO public.owner_memory(id,owner_id,text_content,category,topic,source_ids,adoption_method) VALUES($1,$2,'合成本人资料：偏好清淡食物。','preference','health',$3,'manual')",
      [ownerMemory2, owner, [owner]],
    );
    await fixture.client.query(
      "INSERT INTO public.owner_memory_state(owner_id,memory_revision) VALUES($1,1) ON CONFLICT(owner_id) DO UPDATE SET memory_revision=GREATEST(owner_memory_state.memory_revision,1)",
      [owner],
    );
    await fixture.client.query(
      "INSERT INTO public.background_task(id,owner_id,contact_id,task_type,status,current_step,message_count) VALUES($1,$2,NULL,'layered_memory','succeeded','organize_memory',0)",
      [task, owner],
    );
    await fixture.client.query(`
      INSERT INTO public.layered_memory_job
        (task_id,owner_id,contact_id,settings_generation,target_key,contract,target_manifest,dependency_ids,
         state,revision,last_action,batch_number,run_remaining,pending_receipt,model_calls_used,model_call_limit,
         profile_required,profile_status,target_dirty_revision)
      VALUES($1,$2,NULL,0,'synthetic:l3-gui','synthetic-gui-contract',$3,$4,'paused',1,'pause',1,0,false,0,0,true,'succeeded',1)
    `, [task, owner, JSON.stringify(manifest), [ownerMemory1, ownerMemory2, owner]]);
    await fixture.client.query(`
      INSERT INTO public.layered_memory_state
        (owner_id,contact_id,settings_generation,organization_generation,enabled,status,covered_count,updated_at,
         dirty_revision,consumed_revision,maintenance_allowed)
      VALUES($1,NULL,0,1,true,'ready',2,clock_timestamp(),1,1,false)
      ON CONFLICT(owner_id,scope_kind,scope_key) DO UPDATE SET
        settings_generation=0,organization_generation=1,enabled=true,status='ready',covered_count=2,
        updated_at=clock_timestamp(),dirty_revision=1,consumed_revision=1,maintenance_allowed=false,error_code=NULL
    `, [owner]);
    await fixture.client.query(`
      INSERT INTO public.layered_memory_batch
        (id,owner_id,contact_id,settings_generation,work_key,status,input_manifest,input_payload,output_payload,
         dependency_ids,created_at,task_id,scenario_input)
      VALUES($1,$2,NULL,0,'synthetic-scenario-gui','succeeded',$3,'{}','{}',$4,clock_timestamp(),$5,'[]')
    `, [scenarioBatch, owner, JSON.stringify(manifest), [ownerMemory1, ownerMemory2], task]);
    await fixture.client.query(`
      INSERT INTO public.scenario_document_version
        (id,owner_id,contact_id,scenario_id,batch_id,organization_generation,schema_version,title,hint,paragraphs,
         created_at)
      VALUES($1,$2,NULL,$3,$4,0,1,'合成长期场景','仅用于隔离桌面动作验收',$5,clock_timestamp())
    `, [scenarioVersion, owner, scenarioId, scenarioBatch, JSON.stringify([{
      text:'合成场景：共同参加过一次桌面验收课程。',
      references:[references[0]],
    }])]);
    async function insertProfile(batchId, versionId, generation, workKey) {
      await fixture.client.query(`
        INSERT INTO public.layered_profile_batch
          (id,owner_id,contact_id,settings_generation,organization_generation,work_key,work_token,budget_batch_id,
           task_id,status,attempt_count,lease_expires_at,scenario_version_ids,input_manifest,input_payload,
           output_payload,dependency_ids,created_at)
        VALUES($1,$2,NULL,0,$3,$4,$5,$6,$7,'succeeded',1,clock_timestamp()+interval '1 day',$8,$9,'{}','{}',$10,clock_timestamp())
      `, [batchId, owner, generation, workKey, randomUUID(), scenarioBatch, task, [scenarioVersion],
        JSON.stringify(manifest), [ownerMemory1, ownerMemory2, owner]]);
      await fixture.client.query(`
        INSERT INTO public.layered_profile_version
          (id,owner_id,contact_id,batch_id,schema_version,entries,withdrawn,created_at)
        VALUES($1,$2,NULL,$3,2,$4,false,clock_timestamp())
      `, [versionId, owner, batchId, JSON.stringify(profileEntries)]);
      await fixture.client.query(`
        INSERT INTO public.layered_memory_generation
          (owner_id,contact_id,organization_generation,schema_version,scenario_version_ids,profile_version_id,
           dependency_ids,created_at)
        VALUES($1,NULL,$2,2,$3,$4,$5,clock_timestamp())
      `, [owner, generation, [scenarioVersion], versionId,
        [ownerMemory1, ownerMemory2, owner]]);
    }
    await insertProfile(profileBatch, profileVersion, 1, 'synthetic-profile-gui-1');
    await fixture.client.query('COMMIT');
  } catch (error) {
    await fixture.client.query('ROLLBACK');
    throw error;
  }
  const userData = path.join(fixture.directory, 'desktop');
  await mkdir(userData, { recursive: true });
  await writeFile(
    path.join(fixture.envFilePath),
    `${await readFile(fixture.envFilePath, 'utf8')}NOTALONE_OWNER_ID=${owner}\nNOTALONE_DEEPSEEK_API_KEY=synthetic_l3_gui_unused_key\n`,
    { mode:0o600 },
  );
  await writeFile(path.join(userData, 'backend-launch.json'), JSON.stringify({
    pythonExecutable:python,
    projectDirectory:root,
    envFilePath:fixture.envFilePath,
    backendInfoPath:path.join(fixture.directory, 'backend.info'),
    wechatCliPath:path.join(fixture.directory, 'unavailable-cli'),
    syncProbePath:path.join(fixture.directory, 'unavailable-probe'),
  }), { mode:0o600 });
  const current = {
    directory:fixture.directory,
    database:fixture.client.database,
    envFilePath:fixture.envFilePath,
    userData,
    owner,
    contact,
    task,
    scenarioBatch,
    scenarioVersion,
    profileBatch,
    profileVersion,
    organizationGeneration:1,
    synthetic:true,
  };
  await writeFile(statePath, `${JSON.stringify(current, null, 2)}\n`, { mode:0o600 });
  await chmod(statePath, 0o600);
  await fixture.client.end();
  console.log(JSON.stringify({
    statePath,
    database:current.database,
    userData,
    owner,
    contact,
    profileVersion,
    organizationGeneration:1,
  }));
}

async function rearm() {
  const current = await state();
  const pg = createRequire(path.join(root, 'backend-ts/package.json'))('pg');
  const client = new pg.Client({host:'/tmp', database:current.database, user:'wye'});
  await client.connect();
  try {
    const generation = Number((await client.query('SELECT max(organization_generation) n FROM public.layered_memory_generation')).rows[0].n) + 1;
    const batchId = randomUUID();
    const versionId = randomUUID();
    const previous = await client.query(`
      SELECT b.input_manifest,b.dependency_ids,b.scenario_version_ids
      FROM public.layered_profile_version v JOIN public.layered_profile_batch b ON b.id=v.batch_id
      WHERE v.id=$1
    `, [current.profileVersion]);
    const source = previous.rows[0];
    const entries = (await client.query('SELECT entries FROM public.layered_profile_version WHERE id=$1', [current.profileVersion])).rows[0].entries;
    await client.query('BEGIN');
    await client.query(`
      INSERT INTO public.layered_profile_batch
        (id,owner_id,contact_id,settings_generation,organization_generation,work_key,work_token,budget_batch_id,
         task_id,status,attempt_count,lease_expires_at,scenario_version_ids,input_manifest,input_payload,
         output_payload,dependency_ids,created_at)
      VALUES($1,$2,NULL,0,$3,$4,$5,$6,$7,'succeeded',1,clock_timestamp()+interval '1 day',$8,$9,'{}','{}',$10,clock_timestamp())
    `, [batchId, current.owner, generation, `synthetic-profile-gui-${generation}`, randomUUID(),
      current.scenarioBatch, current.task, source.scenario_version_ids, JSON.stringify(source.input_manifest), source.dependency_ids]);
    await client.query(`
      INSERT INTO public.layered_profile_version
        (id,owner_id,contact_id,batch_id,schema_version,entries,withdrawn,created_at)
      VALUES($1,$2,NULL,$3,2,$4,false,clock_timestamp())
    `, [versionId, current.owner, batchId, JSON.stringify(entries)]);
    await client.query(`
      INSERT INTO public.layered_memory_generation
        (owner_id,contact_id,organization_generation,schema_version,scenario_version_ids,profile_version_id,
         dependency_ids,created_at)
      VALUES($1,NULL,$2,2,$3,$4,$5,clock_timestamp())
    `, [current.owner, generation, source.scenario_version_ids, versionId, source.dependency_ids]);
    await client.query(`
      UPDATE public.layered_memory_state
      SET organization_generation=$2,status='ready',error_code=NULL,updated_at=clock_timestamp()
      WHERE owner_id=$1 AND scope_kind='owner' AND scope_key=$1
    `, [current.owner, generation]);
    await client.query('COMMIT');
    current.profileBatch = batchId;
    current.profileVersion = versionId;
    current.organizationGeneration = generation;
    await writeFile(statePath, `${JSON.stringify(current, null, 2)}\n`, { mode:0o600 });
    console.log(JSON.stringify({profileVersion:versionId, profileBatch:batchId, organizationGeneration:generation}));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

if (command === 'setup') await setup();
else if (command === 'rearm') await rearm();
else if (command === 'cleanup') await cleanup();
else throw new Error('usage: fixture.mjs setup|rearm|cleanup');
