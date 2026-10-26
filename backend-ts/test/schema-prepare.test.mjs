import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm,readdir,readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const migrationsDirectory=new URL('../database/migrations',import.meta.url).pathname;
async function fixture(t){
 const name=`notalone_schema_ts_${randomUUID().replaceAll('-','')}_test`;
 const admin=new pg.Client({host:'/tmp',database:'postgres'});await admin.connect();
 await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
 const directory=await mkdtemp(join(tmpdir(),'notalone-schema-prepare-'));
 t.after(async()=>{await admin.query(`DROP DATABASE "${name}"`);await admin.end();await rm(directory,{recursive:true,force:true});});
 return {databaseUrl:`host=/tmp dbname=${name}`,migrationsDirectory,environment:{HOME:directory,NOTALONE_SKILLS_DIR:join(directory,'skills')}};
}
async function seedThrough(options,through){
 const client=new pg.Client({connectionString:undefined,host:'/tmp',database:options.databaseUrl.split('dbname=')[1]});await client.connect();
 await client.query('CREATE TABLE public.notalone_schema_migration(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
 for(const name of (await readdir(migrationsDirectory)).filter(name=>name.endsWith('.sql')&&Number(name.slice(0,3))<=through).sort()){
  const bytes=await readFile(join(migrationsDirectory,name));await client.query(bytes.toString('utf8'));
  await client.query('INSERT INTO public.notalone_schema_migration(name,checksum) VALUES($1,$2)',[name,createHash('sha256').update(bytes).digest('hex')]);
 }
 return client;
}
test('无 Python 和 Conda 的首次 schema 准备执行原116份迁移，重开只读就绪且不重放',async t=>{
 const options=await fixture(t);
 const {prepareDatabaseSchema}=await import('../src/schema-prepare.ts');
 const result=await prepareDatabaseSchema(options);
 assert.equal(result.code,'ready');assert.equal(result.applied.length,116);
 assert.equal(result.applied[0],'001_initial_ingest.sql');
 assert.deepEqual(await prepareDatabaseSchema(options),{code:'ready',applied:[]});
});
test('诊断CLI在无Python的PATH下只读返回pending，显式prepare才写入且不回显敏感配置',async t=>{
 const options=await fixture(t),envFilePath=join(options.environment.HOME,'synthetic.env');
 await writeFile(envFilePath,`NOTALONE_DATABASE_URL=${options.databaseUrl}\nNOTALONE_DEEPSEEK_API_KEY=synthetic-secret\n`,{mode:0o600});
 const before=await readFile(envFilePath);
 const invoke=(prepare=false)=>spawnSync(process.execPath,['--experimental-strip-types','--no-warnings',new URL('../src/schema-prepare-cli.ts',import.meta.url).pathname,'--migrations',migrationsDirectory,...(prepare?['--prepare']:[])],{
  env:{PATH:'/usr/bin:/bin',HOME:options.environment.HOME,NOTALONE_ENV_FILE:envFilePath,NOTALONE_HOST_RUNTIME:'typescript'},encoding:'utf8',timeout:15000});
 const diagnostic=invoke();assert.equal(diagnostic.status,1);assert.deepEqual(JSON.parse(diagnostic.stdout),{code:'migration_pending'});assert.equal(diagnostic.stderr,'');
 const client=new pg.Client({host:'/tmp',database:options.databaseUrl.split('dbname=')[1]});await client.connect();
 assert.equal((await client.query("SELECT to_regclass('public.notalone_schema_migration') AS ledger")).rows[0].ledger,null);await client.end();
 const prepared=invoke(true);assert.equal(prepared.status,0);assert.equal(JSON.parse(prepared.stdout).applied.length,116);
 assert.deepEqual(await readFile(envFilePath),before);assert.doesNotMatch(prepared.stdout,/synthetic-secret|dbname=|\/tmp/);
});
test('102旧库的Skill正文和资源先完整核验落盘，原身份与历史checksum保留',async t=>{
 const options=await fixture(t),client=await seedThrough(options,102);
 const owner=randomUUID(),skill=randomUUID(),version=randomUUID(),resource=Buffer.from('合成资源，仅用于场景说明。');
 await client.query("INSERT INTO public.owner(id,display_name) VALUES($1,'合成用户')",[owner]);
 await client.query("INSERT INTO public.skill_library(owner_id,revision) VALUES($1,1)",[owner]);
 await client.query("INSERT INTO public.reply_skill(id,owner_id,name,description) VALUES($1,$2,'legacy-reply','适合温和回应')",[skill,owner]);
 await client.query("INSERT INTO public.reply_skill_version(id,skill_id,version_number,name,description,content,content_sha256,is_current,validation_warnings) VALUES($1,$2,1,'legacy-reply','适合温和回应','先回应感受。',$3,true,'[\"旧版警告\"]')",[version,skill,createHash('sha256').update('先回应感受。').digest('hex')]);
 await client.query("INSERT INTO public.reply_skill_resource(skill_version_id,relative_path,resource_kind,media_type,byte_size,content_sha256,content) VALUES($1,'references/example.md','reference','text/markdown',$2,$3,$4)",[version,resource.length,createHash('sha256').update(resource).digest('hex'),resource]);
 const contact=randomUUID(),draft=randomUUID(),logical=randomUUID(),method=randomUUID();
 await client.query("INSERT INTO public.contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contact,owner]);
 await client.query("INSERT INTO public.skill_draft(id,owner_id,contact_id,logical_skill_id,proposal_kind,batch_key,status) VALUES($1,$2,$3,$4,'create','synthetic','published')",[draft,owner,contact,logical]);
 await client.query("INSERT INTO public.reply_skill_publication(version_id,owner_id,origin_contact_id,draft_id,logical_skill_id,scope_kind) VALUES($1,$2,$3,$4,$5,'owner')",[version,owner,contact,draft,logical]);
 await client.query("INSERT INTO public.reply_skill_method(version_id,method_id,logical_skill_id,ordinal,title,instruction,mapping_state) VALUES($1,$2,$3,0,'先回应感受','先确认对方表达的感受，再组织回复。','new')",[version,method,logical]);
 await client.end();
 const {prepareDatabaseSchema}=await import('../src/schema-prepare.ts');
 const result=await prepareDatabaseSchema(options);assert.equal(result.code,'ready');assert.equal(result.applied.length,14);
 const {HostStorage}=await import('../src/host-storage.ts'),{SkillLibrary}=await import('../src/skill-library.ts'),{SkillFiles}=await import('../src/skill-files.ts');
 const storage=await HostStorage.open({envFilePath:'',migrationsDirectory,environment:{...options.environment,NOTALONE_DISABLE_DOTENV:'1',NOTALONE_DATABASE_URL:options.databaseUrl,NOTALONE_OWNER_ID:owner}});t.after(()=>storage.close());
 const library=new SkillLibrary(storage,new SkillFiles(options.environment.NOTALONE_SKILLS_DIR));
 const inspected=new pg.Client({host:'/tmp',database:options.databaseUrl.split('dbname=')[1]});await inspected.connect();
 const row=(await inspected.query('SELECT version.*,skill.owner_id,skill.name FROM public.reply_skill_version version JOIN public.reply_skill skill ON skill.id=version.skill_id WHERE version.id=$1',[version])).rows[0];await inspected.end();
 const files=new SkillFiles(options.environment.NOTALONE_SKILLS_DIR);
 assert.equal(files.readContent(row),'先回应感受。');
 assert.deepEqual(files.readManifest(row).warnings,['旧版警告']);
 assert.deepEqual(files.readMethods(row,[method]),[{method_id:method,title:'先回应感受',instruction:'先确认对方表达的感受，再组织回复。'}]);
 const listed=await library.handle('GET',new URL('http://local/api/skills'));
 assert.equal(listed.skills[0].skill_id,skill);assert.equal(listed.skills[0].current_version_id,version);
 assert.deepEqual(await prepareDatabaseSchema(options),{code:'ready',applied:[]});
});
// 完整旧Python公开schema比较器保留在固定23a历史命令，正常测试不导入HEAD旧树。
test('114原库更新拒绝其它连接与迁移锁，释放后保留原本人身份补齐115/116',async t=>{
 const options=await fixture(t),client=await seedThrough(options,114),owner=randomUUID();
 await client.query("INSERT INTO public.owner(id,display_name) VALUES($1,'保留的合成本人')",[owner]);
 const {prepareDatabaseSchema}=await import('../src/schema-prepare.ts');
 assert.deepEqual(await prepareDatabaseSchema(options),{code:'database_writers_present',applied:[]});
 await client.query('SELECT pg_advisory_lock(1852798049,1)');
 assert.deepEqual(await prepareDatabaseSchema(options),{code:'migration_busy',applied:[]});
 await client.query('SELECT pg_advisory_unlock(1852798049,1)');await client.end();
 const result=await prepareDatabaseSchema(options);assert.equal(result.code,'ready');assert.equal(result.applied.length,2);
 assert.match(result.applied[0],/^115_/);assert.match(result.applied[1],/^116_complete_claim_verification_policy/);
 const {HostStorage}=await import('../src/host-storage.ts'),storage=await HostStorage.open({envFilePath:'',migrationsDirectory,environment:{...options.environment,NOTALONE_DATABASE_URL:options.databaseUrl,NOTALONE_DISABLE_DOTENV:'1',NOTALONE_OWNER_ID:owner}});
 try{assert.equal((await storage.setupStatus()).runtime_owner_configured,true);}finally{await storage.close();}
});
test('未登记旧结构、未知迁移与改变历史checksum均停写，拒绝PGOPTIONS隐式目标',async t=>{
 const options=await fixture(t),{prepareDatabaseSchema}=await import('../src/schema-prepare.ts');
 assert.deepEqual(await prepareDatabaseSchema({...options,environment:{...options.environment,PGOPTIONS:'-c application_name=synthetic'}}),{code:'database_update_requires_local',applied:[]});
 const client=new pg.Client({host:'/tmp',database:options.databaseUrl.split('dbname=')[1]});await client.connect();
 await client.query('CREATE TABLE public.synthetic_existing(id int)');await client.end();
 assert.deepEqual(await prepareDatabaseSchema(options),{code:'baseline_missing',applied:[]});
 const other=await fixture(t),seeded=await seedThrough(other,114);
 await seeded.query("INSERT INTO public.notalone_schema_migration(name,checksum) VALUES('117_unknown.sql','unknown')");await seeded.end();
 assert.deepEqual(await prepareDatabaseSchema(other),{code:'migration_history_mismatch',applied:[]});
 const changed=new pg.Client({host:'/tmp',database:other.databaseUrl.split('dbname=')[1]});await changed.connect();
 await changed.query("DELETE FROM public.notalone_schema_migration WHERE name='117_unknown.sql'");await changed.query("UPDATE public.notalone_schema_migration SET checksum='changed' WHERE name LIKE '001_%'");await changed.end();
 assert.deepEqual(await prepareDatabaseSchema(other),{code:'migration_history_mismatch',applied:[]});
});
test('035审计基线只登记036后的真实执行，损坏凭证停止后可按原库更新',async t=>{
 const options=await fixture(t),client=await seedThrough(options,35),{prepareDatabaseSchema}=await import('../src/schema-prepare.ts');
 const manifest=(await client.query('SELECT name,checksum FROM public.notalone_schema_migration ORDER BY name')).rows;
 await client.query('CREATE TABLE public.notalone_schema_baseline(format_version integer,through_version integer,manifest jsonb,backup_sha256 text,restore_verified_at timestamptz)');
 await client.query('INSERT INTO public.notalone_schema_baseline VALUES(1,35,$1,$2,now())',[JSON.stringify(manifest),'a'.repeat(64)]);
 await client.query('DELETE FROM public.notalone_schema_migration');await client.query('UPDATE public.notalone_schema_baseline SET through_version=34');await client.end();
 assert.deepEqual(await prepareDatabaseSchema(options),{code:'baseline_invalid',applied:[]});
 const fixed=new pg.Client({host:'/tmp',database:options.databaseUrl.split('dbname=')[1]});await fixed.connect();await fixed.query('UPDATE public.notalone_schema_baseline SET through_version=35');await fixed.end();
 const result=await prepareDatabaseSchema(options);assert.equal(result.code,'ready');assert.equal(result.applied.length,81);assert.match(result.applied[0],/^036_/);
});
test('SQL试图中途COMMIT时当前版本及账本一起回滚，修复后继续且不重放114',async t=>{
 const options=await fixture(t),client=await seedThrough(options,114);await client.end();
 const directory=join(options.environment.HOME,'migrations');await mkdir(directory);
 for(const name of (await readdir(migrationsDirectory)).filter(name=>name.endsWith('.sql')))await copyFile(join(migrationsDirectory,name),join(directory,name));
 const last=(await readdir(directory)).find(name=>name.startsWith('115_'));
 await writeFile(join(directory,last),'BEGIN;\nCREATE TABLE public.must_rollback(id int); COMMIT; CREATE TABLE public.must_not_survive(id int);\nCOMMIT;\n');
 const {prepareDatabaseSchema}=await import('../src/schema-prepare.ts');
 assert.deepEqual(await prepareDatabaseSchema({...options,migrationsDirectory:directory}),{code:'migration_failed',applied:[]});
 const inspected=new pg.Client({host:'/tmp',database:options.databaseUrl.split('dbname=')[1]});await inspected.connect();
 assert.deepEqual((await inspected.query("SELECT to_regclass('public.must_rollback') AS first,to_regclass('public.must_not_survive') AS second,(SELECT count(*)::int FROM public.notalone_schema_migration) AS count")).rows[0],{first:null,second:null,count:114});await inspected.end();
 const result=await prepareDatabaseSchema(options);assert.equal(result.code,'ready');assert.equal(result.applied.length,2);
});
test('103旧Skill字节不符合原checksum时事务回滚，旧正文与102账本完整保留',async t=>{
 const options=await fixture(t),client=await seedThrough(options,102),owner=randomUUID(),skill=randomUUID(),version=randomUUID();
 await client.query("INSERT INTO public.owner(id,display_name) VALUES($1,'合成旧库')",[owner]);
 await client.query("INSERT INTO public.reply_skill(id,owner_id,name,description) VALUES($1,$2,'damaged-reply','适合合成场景')",[skill,owner]);
 await client.query("INSERT INTO public.reply_skill_version(id,skill_id,version_number,name,description,content,content_sha256) VALUES($1,$2,1,'damaged-reply','适合合成场景','必须保留的旧字节',$3)",[version,skill,'0'.repeat(64)]);await client.end();
 const {prepareDatabaseSchema}=await import('../src/schema-prepare.ts');assert.deepEqual(await prepareDatabaseSchema(options),{code:'migration_failed',applied:[]});
 const inspected=new pg.Client({host:'/tmp',database:options.databaseUrl.split('dbname=')[1]});await inspected.connect();
 try{
  assert.equal((await inspected.query('SELECT content FROM public.reply_skill_version WHERE id=$1',[version])).rows[0].content,'必须保留的旧字节');
  assert.equal((await inspected.query('SELECT count(*)::int AS count FROM public.notalone_schema_migration')).rows[0].count,102);
  assert.equal((await inspected.query("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='reply_skill_version' AND column_name='manifest_sha256') AS present")).rows[0].present,false);
 }finally{await inspected.end();}
});
