import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostStorage } from '../src/platform/database/host-storage.ts';

const migrationsDirectory = new URL('../database/migrations/', import.meta.url).pathname;
test('受控配置保留模型和资料位置，凭据不进入状态响应', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notalone-host-storage-'));
  try {
    const envFilePath = join(directory, '.env');
    await writeFile(envFilePath, '# 合成配置\nexport NOTALONE_DEEPSEEK_API_KEY="synthetic-key"\nNOTALONE_DEEPSEEK_MODEL=custom-model\nNOTALONE_DEEPSEEK_BASE_URL=https://example.invalid/v1\nNOTALONE_DATABASE_URL=host=/tmp dbname=synthetic_test\nNOTALONE_SKILLS_DIR=/synthetic/original\n');
    const storage = await HostStorage.open({ envFilePath, migrationsDirectory, environment: {} });
    assert.deepEqual(storage.credentialStatus(), { provider: 'deepseek', configured: true });
    assert.equal(storage.databaseUrl, 'host=/tmp dbname=synthetic_test');
    assert.equal(storage.runtimeOwnerId, undefined);
    assert.equal(JSON.stringify(storage.credentialStatus()).includes('synthetic-key'), false);
    assert.equal(await readFile(envFilePath, 'utf8').then(x => x.includes('custom-model')), true);
    await storage.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

import { createStorageFixture } from './host-storage-fixture.mjs';

test('原账本及125升级只读核验后允许首次本人创建，重开恢复且不猜选既有本人', async () => {
  const fixture = await createStorageFixture();
  try {
    const storage = await HostStorage.open(fixture.options);
    assert.deepEqual(await storage.compatibility(), { code: 'ready' });
    assert.equal((await storage.setupStatus()).owner_configured, false);
    const first = await storage.initializeOwner('合成本人');
    assert.equal(first.created, true);
    const restored = await HostStorage.open(fixture.options);
    assert.equal(restored.runtimeOwnerId, first.owner_id);
    assert.equal((await restored.setupStatus()).runtime_owner_configured, true);
    await assert.rejects(restored.initializeOwner('重复'), { code: 'owner_already_configured' });
    const unbound = await HostStorage.open({ ...fixture.options, environment: { NOTALONE_OWNER_ID: '' } });
    assert.equal((await unbound.setupStatus()).runtime_owner_configured, false);
    await assert.rejects(unbound.initializeOwner('猜选'), { code: 'owner_already_configured' });
    assert.equal((await fixture.client.query('SELECT count(*)::int AS n FROM public.owner')).rows[0].n, 1);
    assert.equal((await fixture.client.query('SELECT count(*)::int AS n FROM public.notalone_schema_migration')).rows[0].n, 125);
  } finally { await fixture.close(); }
});

test('凭据原子保存保留其余配置、权限0600，账本漂移后阻止本人及凭据写入', async () => {
  const fixture = await createStorageFixture();
  try {
    await writeFile(fixture.envFilePath, (await readFile(fixture.envFilePath, 'utf8')) + 'NOTALONE_DEEPSEEK_MODEL=custom-model\nNOTALONE_DEEPSEEK_BASE_URL=https://example.invalid/v1\nexport NOTALONE_DEEPSEEK_API_KEY=old-key\nNOTALONE_DEEPSEEK_API_KEY=duplicate-key\n');
    const storage = await HostStorage.open(fixture.options);
    assert.equal((await storage.setupStatus()).runtime_configuration_pending, false);
    assert.deepEqual(await storage.writeCredentials('new-synthetic-key'), {provider:'deepseek', configured:true, restart_required:true});
    assert.equal((await storage.setupStatus()).runtime_configuration_pending, true);
    assert.doesNotMatch(JSON.stringify(await storage.setupStatus()), /new-synthetic-key|old-key|duplicate-key/);
    const fresh = await HostStorage.open(fixture.options);
    assert.equal((await fresh.setupStatus()).runtime_configuration_pending, false);
    await fresh.close();
    await storage.writeCredentials('custom.token+synthetic=');
    assert.equal((await HostStorage.open(fixture.options)).runtimeEnvironment().NOTALONE_DEEPSEEK_API_KEY, 'custom.token+synthetic=');
    const saved = await readFile(fixture.envFilePath, 'utf8');
    assert.equal(saved.includes('custom-model'), true);
    assert.equal(saved.includes('old-key'), false);
    assert.equal(saved.match(/NOTALONE_DEEPSEEK_API_KEY=/g).length, 1);
    assert.equal((await stat(fixture.envFilePath)).mode & 0o777, 0o600);
    assert.equal((await storage.setupStatus()).official_deepseek_defaults, false);
    await assert.rejects(storage.writeCredentials('bad\nNOTALONE_OWNER_ID=attack'), {code:'setup_request_invalid'});
    assert.deepEqual(await storage.useOfficialDeepseek('official-synthetic-key'), {provider:'deepseek', configured:true, official_deepseek_defaults:true, restart_required:true});
    await fixture.client.query("UPDATE public.notalone_schema_migration SET checksum='changed' WHERE name='107_history_message_count_comment.sql'");
    assert.deepEqual(await storage.compatibility(), {code:'migration_history_mismatch'});
    const before = await readFile(fixture.envFilePath, 'utf8');
    await assert.rejects(storage.initializeOwner('不能写入'), {code:'migration_history_mismatch'});
    await assert.rejects(storage.writeCredentials('must-not-save'), {code:'migration_history_mismatch'});
    assert.equal(await readFile(fixture.envFilePath, 'utf8'), before);
    assert.equal((await fixture.client.query('SELECT count(*)::int AS n FROM public.owner')).rows[0].n, 0);
  } finally { await fixture.close(); }
});

test('并发首启只有一个本人；未知版本和缺失结构均失败关闭', async () => {
  const fixture = await createStorageFixture();
  try {
    const first = await HostStorage.open(fixture.options);
    const second = await HostStorage.open(fixture.options);
    const results = await Promise.allSettled([first.initializeOwner('合成一'), second.initializeOwner('合成二')]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal((await fixture.client.query('SELECT count(*)::int AS n FROM public.owner')).rows[0].n, 1);
    const winner = results.find(result => result.status === 'fulfilled').value;
    const reopened = await HostStorage.open(fixture.options);
    assert.equal(reopened.runtimeOwnerId, winner.owner_id);
    await fixture.client.query("INSERT INTO public.notalone_schema_migration(name,checksum) VALUES('117_unknown.sql','unknown')");
    assert.deepEqual(await reopened.compatibility(), {code:'migration_history_mismatch'});
    await assert.rejects(reopened.writeCredentials('blocked'), {code:'migration_history_mismatch'});
    await fixture.client.query("DELETE FROM public.notalone_schema_migration WHERE name='117_unknown.sql'");
    await fixture.client.query('ALTER TABLE public.owner RENAME COLUMN display_name TO lost_display_name');
    assert.deepEqual(await reopened.compatibility(), {code:'schema_incomplete'});
    await assert.rejects(reopened.initializeOwner('不能写入'), {code:'schema_incomplete'});
  } finally { await fixture.close(); }
});

test('035接管基线与后续账本分开校验，未完成迁移只读停写', async () => {
  const fixture = await createStorageFixture();
  try {
    const manifest = (await fixture.client.query('SELECT name,checksum FROM public.notalone_schema_migration ORDER BY name LIMIT 35')).rows;
    await fixture.client.query('CREATE TABLE public.notalone_schema_baseline(format_version integer,through_version integer,manifest jsonb,backup_sha256 text,restore_verified_at timestamptz)');
    await fixture.client.query('INSERT INTO public.notalone_schema_baseline VALUES(1,35,$1::jsonb,$2,now())', [JSON.stringify(manifest), 'a'.repeat(64)]);
    await fixture.client.query("DELETE FROM public.notalone_schema_migration WHERE name <= '035_extraction_watermark_cascade.sql'");
    const storage = await HostStorage.open(fixture.options);
    assert.deepEqual(await storage.compatibility(), {code:'ready'});
    const before = (await fixture.client.query('SELECT * FROM public.notalone_schema_migration ORDER BY name')).rows;
    await storage.compatibility();
    assert.deepEqual((await fixture.client.query('SELECT * FROM public.notalone_schema_migration ORDER BY name')).rows, before);
    const middle=(await fixture.client.query("DELETE FROM public.notalone_schema_migration WHERE name='115_user_cancelled_generation.sql' RETURNING name,checksum")).rows[0];
    assert.deepEqual(await storage.compatibility(), {code:'migration_history_mismatch'});
    await fixture.client.query('INSERT INTO public.notalone_schema_migration(name,checksum) VALUES($1,$2)',[middle.name,middle.checksum]);
    await fixture.client.query("DELETE FROM public.notalone_schema_migration WHERE name='125_memory_processing_control.sql'");
    assert.deepEqual(await storage.compatibility(), {code:'migration_pending'});
    await assert.rejects(storage.initializeOwner('不自动迁移'), {code:'migration_pending'});
    await fixture.client.query('UPDATE public.notalone_schema_baseline SET restore_verified_at=NULL');
    assert.deepEqual(await storage.compatibility(), {code:'baseline_invalid'});
  } finally { await fixture.close(); }
});

test('受控配置符号链接失败关闭，不改写原目标文件', async () => {
  const { symlink } = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'notalone-host-config-'));
  try {
    const target = join(directory, 'target');
    const envFilePath = join(directory, 'linked-env');
    await writeFile(target, 'NOTALONE_DEEPSEEK_API_KEY=synthetic-key\n');
    await symlink(target, envFilePath);
    await assert.rejects(HostStorage.open({envFilePath,migrationsDirectory,environment:{}}), {code:'configuration_unavailable'});
    assert.equal(await readFile(target, 'utf8'), 'NOTALONE_DEEPSEEK_API_KEY=synthetic-key\n');
  } finally { await rm(directory, {recursive:true,force:true}); }
});

test('关闭后拒绝新配置写入，关闭中的事务不得迟到提交', async()=>{
  const fixture=await createStorageFixture();
  try {
    const storage=await HostStorage.open(fixture.options);
    await storage.close();
    await assert.rejects(storage.initializeOwner('退出后禁止创建'),{code:'runtime_stopping'});
    await assert.rejects(storage.writeCredentials('late-synthetic-key'),{code:'runtime_stopping'});
    assert.equal((await fixture.client.query('SELECT count(*)::int AS n FROM owner')).rows[0].n,0);
  }finally{await fixture.close();}
});

test('明确恢复唯一已有本人保持原ID；多本人拒绝猜选；配置失败可重试',async()=>{
  const {randomUUID}=await import('node:crypto');
  const {rename,mkdir}=await import('node:fs/promises');
  const fixture=await createStorageFixture();
  try {
    const original=randomUUID();
    await fixture.client.query('INSERT INTO owner(id,display_name) VALUES($1,$2)',[original,'原有合成本人']);
    const storage=await HostStorage.open(fixture.options);
    assert.equal((await storage.setupStatus()).recoverable_owner,true);
    await rename(fixture.envFilePath,fixture.envFilePath+'.saved');await mkdir(fixture.envFilePath);
    await assert.rejects(storage.recoverOwner());
    assert.deepEqual((await fixture.client.query('SELECT id FROM owner')).rows,[{id:original}]);
    await rm(fixture.envFilePath,{recursive:true});await rename(fixture.envFilePath+'.saved',fixture.envFilePath);
    assert.deepEqual(await storage.recoverOwner(),{owner_id:original,created:false});
    assert.equal((await HostStorage.open(fixture.options)).runtimeOwnerId,original);
    await fixture.client.query('INSERT INTO owner(id,display_name) VALUES($1,$2)',[randomUUID(),'第二位合成本人']);
    const unbound=await HostStorage.open({...fixture.options,environment:{NOTALONE_OWNER_ID:''}});
    assert.equal((await unbound.setupStatus()).recoverable_owner,false);
    await assert.rejects(unbound.recoverOwner(),{code:'owner_recovery_ambiguous'});
  }finally{await fixture.close();}
});

test('受控env的PGHOST优先于进程默认socket，不会误连另一库', async () => {
  const fixture=await createStorageFixture();
  try {
    const database=(await fixture.client.query('SELECT current_database() AS name')).rows[0].name;
    await writeFile(fixture.envFilePath,`NOTALONE_DATABASE_URL=dbname=${database}\nPGHOST=${fixture.directory}/missing-socket\n`);
    const storage=await HostStorage.open(fixture.options);
    assert.deepEqual(await storage.compatibility(),{code:'database_unavailable'});
  } finally {await fixture.close();}
});

test('keyword与URI共用受控PGDATABASE/USER/PORT默认值，显式字段覆盖默认值', async () => {
  const fixture=await createStorageFixture();
  try {
    const row=(await fixture.client.query("SELECT current_database() AS database,current_user AS username,current_setting('port') AS port")).rows[0];
    for(const url of ['host=/tmp','postgresql:///?host=%2Ftmp']) {
      await writeFile(fixture.envFilePath,`NOTALONE_DATABASE_URL=${url}\nPGDATABASE=${row.database}\nPGUSER=${row.username}\nPGPORT=${row.port}\nPGSSLMODE=disable\n`);
      assert.deepEqual(await (await HostStorage.open(fixture.options)).compatibility(),{code:'ready'});
      assert.deepEqual(await (await HostStorage.open({...fixture.options,environment:{PGUSER:'notalone_nonexistent_synthetic_role'}})).compatibility(),{code:'database_unavailable'});
      assert.deepEqual(await (await HostStorage.open({...fixture.options,environment:{PGPORT:'1'}})).compatibility(),{code:'database_unavailable'});
    }
    await writeFile(fixture.envFilePath,`NOTALONE_DATABASE_URL=host=/tmp dbname=${row.database} user=${row.username} port=${row.port} sslmode=disable\nPGHOST=/missing\nPGDATABASE=notalone_missing_test\nPGUSER=missing\nPGPORT=1\n`);
    assert.deepEqual(await (await HostStorage.open(fixture.options)).compatibility(),{code:'ready'});
  } finally {await fixture.close();}
});

test('本机hostaddr保留目标且受控密码经PG协议传入，sslmode不静默降级', async () => {
  const {createServer}=await import('node:net');
  const directory=await mkdtemp(join(tmpdir(),'notalone-pg-protocol-'));
  const requests=[];
  const sockets=new Set();
  const server=createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
    let buffer=Buffer.alloc(0),password=false,finished=false;
    socket.on('data',chunk=>{
      if(finished)return;
      buffer=Buffer.concat([buffer,chunk]);
      if(!password && buffer.length>=8) {
        if(buffer.readInt32BE(4)===80877103){requests.push('ssl');socket.end('N');return;}
        const length=buffer.readInt32BE(0);if(buffer.length<length)return;
        requests.push('startup');buffer=buffer.subarray(length);password=true;
        const authentication=Buffer.alloc(9);authentication[0]=82;authentication.writeInt32BE(8,1);authentication.writeInt32BE(3,5);socket.write(authentication);
      }
      if(password && buffer.length>=5 && buffer[0]===112 && buffer.length>=1+buffer.readInt32BE(1)) {
        finished=true;
        requests.push(buffer.subarray(5,buffer.readInt32BE(1)).toString());
        const body=Buffer.from('SFATAL\0C28P01\0Msynthetic rejection\0\0');
        const error=Buffer.alloc(5+body.length);error[0]=69;error.writeInt32BE(4+body.length,1);body.copy(error,5);socket.end(error);
      }
    });
  });
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const port=server.address().port,envFilePath=join(directory,'.env');
    for(const mode of ['disable','prefer','require','allow']) {
      requests.length=0;
      await writeFile(envFilePath,`NOTALONE_DATABASE_URL=host=synthetic.invalid hostaddr=127.0.0.1 dbname=synthetic_test\nPGPORT=${port}\nPGUSER=synthetic\nPGPASSWORD=synthetic-controlled-password\nPGSSLMODE=${mode}\n`);
      const storage=await HostStorage.open({envFilePath,migrationsDirectory,environment:{HOME:directory}});
      assert.deepEqual(await storage.compatibility(),{code:'database_unavailable'});
      assert.deepEqual(requests,mode==='disable'?['startup','synthetic-controlled-password']:mode==='prefer'?['ssl','startup','synthetic-controlled-password']:mode==='allow'?['startup','synthetic-controlled-password','ssl']:['ssl']);
    }
    const {chmod}=await import('node:fs/promises');
    const passfile=join(directory,'custom.pgpass');
    const passContent=`# 合成密码文件\nother.invalid:*:*:*:wrong\nsynthetic.invalid:${port}:synthetic_test:synthetic:first\\:password\\\\tail\n*:*:*:*:later\n`;
    await writeFile(passfile,passContent,{mode:0o600});
    await writeFile(join(directory,'.pgpass'),passContent,{mode:0o600});
    const base=`NOTALONE_DATABASE_URL=host=synthetic.invalid hostaddr=127.0.0.1 dbname=synthetic_test sslmode=disable\nPGPORT=${port}\nPGUSER=synthetic\n`;
    for(const extra of [`PGPASSFILE=${passfile}\n`,'']) {
      requests.length=0;await writeFile(envFilePath,base+extra);
      assert.deepEqual(await (await HostStorage.open({envFilePath,migrationsDirectory,environment:{HOME:directory}})).compatibility(),{code:'database_unavailable'});
      assert.deepEqual(requests,['startup','first:password\\tail']);
    }
    requests.length=0;await chmod(passfile,0o644);await writeFile(envFilePath,base+`PGPASSFILE=${passfile}\n`);
    await (await HostStorage.open({envFilePath,migrationsDirectory,environment:{HOME:directory}})).compatibility();
    assert.deepEqual(requests,['startup','']);
    requests.length=0;await writeFile(envFilePath,base+`PGPASSFILE=${passfile}\nPGPASSWORD=explicit-synthetic\n`);
    await (await HostStorage.open({envFilePath,migrationsDirectory,environment:{HOME:directory}})).compatibility();
    assert.deepEqual(requests,['startup','explicit-synthetic']);
  } finally {
    for(const socket of sockets)socket.destroy();
    await new Promise(resolve=>server.close(resolve));
    await rm(directory,{recursive:true,force:true});
  }
});


test('启动环境覆盖历史已保存凭据或模型时，重开仍待加载且拒绝冲突写入', async () => {
  const fixture = await createStorageFixture();
  try {
    await writeFile(fixture.envFilePath, (await readFile(fixture.envFilePath, 'utf8')) + 'NOTALONE_DEEPSEEK_API_KEY=file-new-synthetic-key\nNOTALONE_DEEPSEEK_MODEL=file-new-model\nNOTALONE_DEEPSEEK_BASE_URL=https://file.example.invalid\n');
    const before = await readFile(fixture.envFilePath, 'utf8');
    for (const [field, old] of Object.entries({ NOTALONE_DEEPSEEK_API_KEY: 'environment-old-synthetic-key', NOTALONE_DEEPSEEK_MODEL: 'environment-old-model', NOTALONE_DEEPSEEK_BASE_URL: 'https://environment.example.invalid' })) {
      const storage = await HostStorage.open({ ...fixture.options, environment: { [field]: old } });
      try {
        const status = await storage.setupStatus();
        assert.equal(status.runtime_configuration_pending, true);
        assert.equal(status.runtime_configuration_environment_override, true);
        assert.doesNotMatch(JSON.stringify(status), /synthetic-key|file-new-model|environment-old-model|example.invalid/);
        await assert.rejects(storage.useOfficialDeepseek('proposed-synthetic-key'), { code: 'configuration_environment_override' });
        if (field === 'NOTALONE_DEEPSEEK_API_KEY') await assert.rejects(storage.writeCredentials('proposed-synthetic-key'), { code: 'configuration_environment_override' });
        assert.equal(await readFile(fixture.envFilePath, 'utf8'), before);
      } finally { await storage.close(); }
    }
    const accepted = await HostStorage.open(fixture.options);
    try { assert.equal((await accepted.setupStatus()).runtime_configuration_pending, false); }
    finally { await accepted.close(); }
  } finally { await fixture.close(); }
});

test('禁止dotenv时不读取受控文件，凭据保存不能承诺重启生效', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notalone-disabled-settings-'));
  try {
    // 目录不能按配置文件读取；open仍须成功，证明没有偷读被禁用的dotenv。
    const storage = await HostStorage.open({ envFilePath: directory, migrationsDirectory, environment: { NOTALONE_DISABLE_DOTENV: '1', NOTALONE_DEEPSEEK_API_KEY: 'environment-only-synthetic-key' } });
    try {
      await assert.rejects(storage.writeCredentials('new-synthetic-key'), { code: 'configuration_environment_override' });
      await assert.rejects(storage.useOfficialDeepseek('new-synthetic-key'), { code: 'configuration_environment_override' });
      assert.doesNotMatch(JSON.stringify(storage.credentialStatus()), /synthetic-key/);
      assert.equal((await stat(directory)).isDirectory(), true);
    } finally { await storage.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('每次业务读取重新核验全部SQL字节，文件故障与同元数据篡改均失败关闭', async () => {
  const { cp, chmod, readdir, utimes, mkdir } = await import('node:fs/promises');
  const fixture = await createStorageFixture();
  const copied = join(fixture.directory, 'migrations');
  let storage;
  try {
    await chmod(fixture.envFilePath, 0o600);
    await cp(fixture.migrationsDirectory, copied, { recursive: true });
    await chmod(copied, 0o700);
    const names = (await readdir(copied)).filter(name => name.endsWith('.sql')).sort();
    for (const name of names) await chmod(join(copied, name), 0o600);
    storage = await HostStorage.open({ ...fixture.options, migrationsDirectory: copied });
    const read = () => storage.businessReadTransaction(async client => (await client.query('SELECT 1 AS value')).rows[0].value);
    assert.equal(await read(), 1);
    const last = join(copied, names.at(-1)), original = await readFile(last), metadata = await stat(last);
    const changed = Buffer.from(original);
    changed[changed.length - 1] ^= 1;
    await writeFile(last, changed);
    await utimes(last, metadata.atime, metadata.mtime);
    await assert.rejects(read(), { code: 'migration_history_mismatch' });
    await writeFile(last, original);
    assert.equal(await read(), 1);
    await rm(last);
    await mkdir(last, { mode: 0o700 });
    await assert.rejects(read(), { code: 'migration_files_invalid' });
    await rm(last, { recursive: true });
    await writeFile(last, original, { mode: 0o600 });
    assert.equal(await read(), 1);
  } finally { await storage?.close(); await fixture.close(); }
});

test('暖读后SQL文件的替换、链接和恢复均按当前真实文件重新核验', async () => {
  const { cp, chmod, readdir, rename, symlink, utimes } = await import('node:fs/promises');
  const fixture = await createStorageFixture();
  const copied = join(fixture.directory, 'migration-identity');
  let storage;
  try {
    await cp(fixture.migrationsDirectory, copied, { recursive: true });
    await chmod(copied, 0o700);
    const names = (await readdir(copied)).filter(name => name.endsWith('.sql')).sort();
    for (const name of names) await chmod(join(copied, name), 0o600);
    storage = await HostStorage.open({ ...fixture.options, migrationsDirectory: copied });
    const read = () => storage.businessReadTransaction(async client => (await client.query('SELECT 1 AS value')).rows[0].value);
    assert.equal(await read(), 1);
    const target = join(copied, names.at(-1)), saved = target + '.saved';
    const original = await readFile(target), metadata = await stat(target);
    await writeFile(saved, original, { mode: 0o600 });
    await utimes(saved, metadata.atime, metadata.mtime);
    await rename(saved, target);
    assert.equal(await read(), 1);
    await rename(target, saved);
    await symlink(saved, target);
    await assert.rejects(read(), { code: 'migration_files_invalid' });
    await rm(target);
    await rename(saved, target);
    assert.equal(await read(), 1);
  } finally { await storage?.close(); await fixture.close(); }
});

test('连续本机业务事务复用清理后的连接，旧事务查询不能进入下一事务', async () => {
  const { randomUUID } = await import('node:crypto');
  const fixture = await createStorageFixture();
  const storage = await HostStorage.open(fixture.options);
  let oldClient, oldQuery;
  try {
    const first = await storage.businessTransaction(async client => {
      oldClient = client;
      oldQuery = client.query.bind(client);
      await client.query('CREATE TEMP TABLE synthetic_lease_only(value integer)');
      await client.query("SET application_name='synthetic_lease_changed'");
      return (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    });
    await oldClient.end();
    const second = await storage.businessTransaction(async client => {
      await assert.rejects(oldQuery('INSERT INTO public.owner(id,display_name) VALUES($1,$2)', [randomUUID(), '不得越过事务的合成写入']));
      const state = (await client.query("SELECT pg_backend_pid() AS pid,to_regclass('pg_temp.synthetic_lease_only') AS temporary,current_setting('application_name') AS application,(SELECT count(*)::int FROM public.owner) AS owners")).rows[0];
      assert.equal(state.temporary, null);
      assert.notEqual(state.application, 'synthetic_lease_changed');
      assert.equal(state.owners, 0);
      return state.pid;
    });
    assert.equal(second, first);
  } finally { await storage.close(); await fixture.close(); }
});

test('并发业务事务各占连接，归还只留一个空闲连接且关闭排空', async () => {
  const { randomUUID } = await import('node:crypto');
  const fixture = await createStorageFixture();
  const storage = await HostStorage.open(fixture.options);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const owner = randomUUID();
  try {
    const first = storage.businessTransaction(async client => {
      await client.query('INSERT INTO public.owner(id,display_name) VALUES($1,$2)', [owner, '并发隔离合成本人']);
      const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      entered(); await gate; return pid;
    });
    await ready;
    const second = await storage.businessReadTransaction(async client => {
      const result = (await client.query('SELECT pg_backend_pid() AS pid,(SELECT count(*)::int FROM public.owner WHERE id=$1) AS owners', [owner])).rows[0];
      assert.equal(result.owners, 0);
      return result.pid;
    });
    release();
    assert.notEqual(await first, second);
    assert.equal((await fixture.client.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND application_name='notalone_ts_host'")).rows[0].n, 1);
    assert.equal(await storage.businessReadTransaction(async client => (await client.query('SELECT count(*)::int AS n FROM public.owner WHERE id=$1', [owner])).rows[0].n), 1);
    await storage.close();
    assert.equal((await fixture.client.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND application_name='notalone_ts_host'")).rows[0].n, 0);
  } finally { release(); await storage.close(); await fixture.close(); }
});

test('租约撤销后的原生Query保留回调身份和返回，复用后的业务错误不被旧观察器污染', async () => {
  const pg = (await import('pg')).default;
  const fixture = await createStorageFixture();
  const storage = await HostStorage.open(fixture.options);
  let oldClient;
  try {
    await storage.businessTransaction(async client => { oldClient = client; await client.query('SELECT 1'); });
    await storage.businessTransaction(async client => {
      await new Promise((resolve, reject) => {
        function callback(error) {
          try { assert.ok(error); assert.equal(this, query); assert.equal(this.callback, callback); resolve(); }
          catch (failure) { reject(failure); }
        }
        const query = new pg.Query('SELECT 1', callback);
        Object.defineProperty(query, 'callback', { value: callback, writable: false });
        query.then = () => assert.fail('迟到Query也不得当作thenable消费');
        assert.equal(oldClient.query(query), query);
      });
      assert.equal((await client.query('SELECT 2 AS value')).rows[0].value, 2);
    });
    const failure = new Error('合成业务错误');
    await assert.rejects(storage.businessTransaction(async client => { await client.query('SELECT 3'); throw failure; }), error => error === failure);
    await assert.rejects(storage.businessTransaction(async client => { await client.query('SELECT 1/0'); }), { code: 'database_unavailable' });
    assert.equal(await storage.businessReadTransaction(async client => (await client.query('SELECT 4 AS value')).rows[0].value), 4);
  } finally { await storage.close(); await fixture.close(); }
});

test('空闲连接被终止后受控失败并另建连接，不重放业务回调', async () => {
  const fixture = await createStorageFixture();
  const storage = await HostStorage.open(fixture.options);
  let calls = 0;
  try {
    const original = await storage.businessReadTransaction(async client => (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    await fixture.client.query('SELECT pg_terminate_backend($1)', [original]);
    await new Promise(resolve => setImmediate(resolve));
    let current;
    try { current = await storage.businessReadTransaction(async client => { calls++; return (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; }); }
    catch (error) { assert.equal(error.code, 'database_unavailable'); assert.equal(calls, 0); }
    if (current === undefined) current = await storage.businessReadTransaction(async client => { calls++; return (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; });
    assert.notEqual(current, original);
    assert.equal(calls, 1);
  } finally { await storage.close(); await fixture.close(); }
});

test('Client链式监听返回当前租约，保存的链和查询不能越过事务或传递监听器', async () => {
  const { randomUUID } = await import('node:crypto');
  const fixture = await createStorageFixture();
  const storage = await HostStorage.open(fixture.options);
  let chain, query, notices = 0, ends = 0;
  const notice = () => { notices++; };
  try {
    const first = await storage.businessTransaction(async client => {
      chain = client.on('notice', notice).once('end', () => { ends++; });
      assert.ok(chain === client, '链式返回必须保持当前租约身份');
      query = chain.query.bind(chain);
      await client.query("DO $$ BEGIN RAISE NOTICE 'synthetic_lease_notice'; END $$");
      return (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    });
    assert.equal(notices, 1);
    assert.equal(ends, 1);
    await storage.businessTransaction(async client => {
      await assert.rejects(query('INSERT INTO public.owner(id,display_name) VALUES($1,$2)', [randomUUID(), '链式迟到查询不得写入']));
      await assert.rejects(chain.query('SELECT 1'));
      await client.query("DO $$ BEGIN RAISE NOTICE 'synthetic_next_lease'; END $$");
      assert.equal(notices, 1);
      assert.notEqual((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, first);
      assert.equal((await client.query('SELECT count(*)::int AS n FROM public.owner')).rows[0].n, 0);
    });
    assert.equal(ends, 1);
  } finally { await storage.close(); await fixture.close(); }
});

test('仅持有空闲业务连接的子进程也必须完成关闭排空', async () => {
  const { execFile } = await import('node:child_process');
  const fixture = await createStorageFixture();
  try {
    const source = `import {HostStorage} from ${JSON.stringify(new URL('../src/platform/database/host-storage.ts', import.meta.url).href)};
const storage=await HostStorage.open({envFilePath:'',migrationsDirectory:${JSON.stringify(fixture.migrationsDirectory)},environment:{NOTALONE_DISABLE_DOTENV:'1',NOTALONE_DATABASE_URL:${JSON.stringify(`host=/tmp dbname=${fixture.client.database}`)}}});
await storage.businessReadTransaction(async client=>client.query('SELECT 1'));
await storage.close();console.log('closed');`;
    const result = await new Promise(resolve => execFile(process.execPath, ['--input-type=module', '--eval', source],
      { env: { PATH: '/usr/bin:/bin' }, timeout: 5000 }, (error, stdout) => resolve({ code: error?.code ?? 0, stdout })));
    assert.equal(result.code, 0, '只有空闲连接的进程也必须完成close');
    assert.equal(result.stdout.trim(), 'closed');
  } finally { await fixture.close(); }
});

test('catalog限定验证投影仍保留未知对象、账本视图与零列必需表的原判定', async () => {
  const fixture = await createStorageFixture();
  const storage = await HostStorage.open(fixture.options);
  const read = () => storage.businessReadTransaction(async client => (await client.query('SELECT 1 AS value')).rows[0].value);
  try {
    await fixture.client.query('CREATE TABLE public.synthetic_unknown_empty(); CREATE VIEW public.synthetic_unknown_view AS SELECT 1 AS value; CREATE SEQUENCE public.synthetic_unknown_sequence');
    assert.equal(await read(), 1);
    await fixture.client.query('ALTER TABLE public.notalone_schema_migration RENAME TO synthetic_saved_ledger; CREATE VIEW public.notalone_schema_migration AS SELECT name,checksum FROM public.synthetic_saved_ledger');
    await assert.rejects(read(), { code: 'baseline_missing' });
    await fixture.client.query('DROP VIEW public.notalone_schema_migration; ALTER TABLE public.synthetic_saved_ledger RENAME TO notalone_schema_migration');
    assert.equal(await read(), 1);
    await fixture.client.query('DROP TABLE public.channel_identity CASCADE; CREATE TABLE public.channel_identity()');
    await assert.rejects(read(), { code: 'schema_incomplete' });
  } finally { await storage.close(); await fixture.close(); }
});

test('复用连接逐次绑定当前passfile凭据，修改、权限变宽与删除均淘汰旧认证', async () => {
  const { chmod } = await import('node:fs/promises');
  const fixture = await createStorageFixture();
  const passfile = join(fixture.directory, 'synthetic.pgpass');
  let storage;
  const previousGlobal = process.env.PGPASSWORD;
  try {
    const line = password => `localhost:5432:${fixture.client.database}:${fixture.client.user}:${password}\n`;
    await writeFile(passfile, line('synthetic-provider-one'), { mode: 0o600 });
    process.env.PGPASSWORD = 'synthetic-global-must-not-fallback';
    storage = await HostStorage.open({ ...fixture.options, environment: { PGPASSFILE: passfile, PGPASSWORD: '' } });
    const pid = () => storage.businessReadTransaction(async client => (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    const original = await pid();
    await writeFile(passfile, line('synthetic-provider-two'));
    const changed = await pid();
    assert.ok(changed !== original, '当前凭据内容改变必须淘汰旧连接');
    await chmod(passfile, 0o644);
    const broad = await pid();
    assert.ok(broad !== changed, 'passfile权限变宽后必须按原规则忽略凭据并淘汰旧连接');
    await chmod(passfile, 0o600);
    const restored = await pid();
    assert.ok(restored !== broad, '恢复有效凭据后重新认证');
    await rm(passfile);
    const deleted = await pid();
    assert.ok(deleted !== restored, '删除passfile后不得继续复用旧认证');
    process.env.PGPASSWORD = 'synthetic-global-changed-again';
    assert.equal(await pid(), deleted, '受控provider为空时不读取全局PGPASSWORD');
  } finally {
    if (previousGlobal === undefined) delete process.env.PGPASSWORD; else process.env.PGPASSWORD = previousGlobal;
    await storage?.close(); await fixture.close();
  }
});

test('暖读后的数据库列与约束仍逐事务新鲜核验，额外列及后台约束保持原规则', async () => {
  const fixture = await createStorageFixture();
  const storage = await HostStorage.open(fixture.options);
  const read = () => storage.businessReadTransaction(async client => (await client.query('SELECT 1 AS value')).rows[0].value);
  try {
    assert.equal(await read(), 1);
    await fixture.client.query('ALTER TABLE public.model_call_receipt ADD COLUMN synthetic_extra text');
    assert.equal(await read(), 1);
    await fixture.client.query('ALTER TABLE public.model_call_receipt ALTER COLUMN synthetic_extra SET NOT NULL');
    await assert.rejects(read(), { code: 'schema_incomplete' });
    await fixture.client.query('ALTER TABLE public.model_call_receipt DROP COLUMN synthetic_extra');
    assert.equal(await read(), 1);
    const definition = (await fixture.client.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.model_call_receipt'::regclass AND conname='model_call_receipt_cache_read_tokens_check'")).rows[0].definition;
    await fixture.client.query('ALTER TABLE public.model_call_receipt DROP CONSTRAINT model_call_receipt_cache_read_tokens_check');
    await assert.rejects(read(), { code: 'schema_incomplete' });
    await fixture.client.query(`ALTER TABLE public.model_call_receipt ADD CONSTRAINT model_call_receipt_cache_read_tokens_check ${definition}`);
    assert.equal(await read(), 1);
    await fixture.client.query('ALTER TABLE public.background_task_step ADD CONSTRAINT synthetic_ignored CHECK(true) NOT VALID');
    assert.equal(await read(), 1);
  } finally { await storage.close(); await fixture.close(); }
});
