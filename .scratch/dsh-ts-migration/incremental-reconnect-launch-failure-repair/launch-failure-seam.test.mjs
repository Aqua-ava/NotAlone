/** 运行完整fixture字节的纯模块接缝；不启动宿主、PG、CLI或模型。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {SourceTextModule,SyntheticModule} from 'node:vm';

const sourcePath=process.env.AUDIT_FIXTURE_SOURCE;
const source=await readFile(sourcePath,'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'),process.env.AUDIT_SOURCE_SHA256);
const exists=async path=>{try{await stat(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};

async function withFixture(t,options,verify){
  const directory=await mkdtemp(join(tmpdir(),'na-reconnect-launch-seam-'));
  const state={launchCalls:0,storageCloseCalls:0,clientEndCalls:0,alive:false,originalError:new Error(options.failBeforeLaunch?'owner_insert_failed':'backend_cleanup_failed')};
  let hook;
  const storage={directory,envFilePath:join(directory,'.env'),client:{
    async query(sql){
      if(sql.includes('current_database() AS name'))return {rows:[{name:'notalone_ts_host_00000000000000000000000000000000_test'}]};
      if(sql.startsWith('INSERT INTO owner(')&&options.failBeforeLaunch)throw state.originalError;
      if(sql.includes('pg_stat_activity'))return {rows:[{n:options.active??0}]};
      if(sql.startsWith('INSERT INTO '))return {rows:[]};
      throw new Error('纯接缝未允许的数据库查询');
    },
    async end(){state.clientEndCalls++;},
  },async close(){state.storageCloseCalls++;await storage.client.end();await rm(directory,{recursive:true,force:true});}};
  await writeFile(storage.envFilePath,'NOTALONE_SYNTHETIC_FIXTURE=1\n');
  const launchDsh=async config=>{
    state.launchCalls++;
    if(options.launchFails)throw state.originalError;
    const profileHome=join(directory,'profile');await mkdir(profileHome);
    await writeFile(config.infoPath,'address=127.0.0.1:1\ntoken=synthetic\n');
    await writeFile(config.infoPath+'.dsh-lock',JSON.stringify({home:profileHome}));
    state.alive=true;
    return {pid:process.pid,isRunning:()=>state.alive,waitForExit:async()=>!state.alive,
      async terminate(){
        if(options.stopConfirmed===false)return false;
        state.alive=false;
        for(const path of [config.infoPath,config.infoPath+'.dsh-lock',profileHome])await rm(path,{recursive:true,force:true});
        return true;
      }};
  };
  const synthetic=exports=>new SyntheticModule(Object.keys(exports),function(){for(const [name,value] of Object.entries(exports))this.setExport(name,value);});
  const module=new SourceTextModule(source,{identifier:pathToFileURL(sourcePath).href,initializeImportMeta(meta){meta.url=pathToFileURL(sourcePath).href;}});
  const builtins=new Set(['node:assert/strict','node:fs/promises','node:path','node:os','node:crypto','node:timers/promises']);
  await module.link(async specifier=>{
    if(specifier==='../src/launch.ts')return synthetic({launchDsh});
    if(specifier==='./host-storage-fixture.mjs')return synthetic({createStorageFixture:async()=>storage});
    if(specifier==='pg')return synthetic({default:{Client:class{
      async connect(){}
      async query(sql){assert.ok(sql.includes('pg_database'));return {rows:[{n:state.storageCloseCalls?0:1}]};}
      async end(){}
    }}});
    assert.ok(builtins.has(specifier),'仅允许fixture既有内置模块');
    return synthetic(await import(specifier));
  });
  try{
    await module.evaluate();
    const create=()=>module.namespace.createReconnectFixture({after(close){hook=close;}});
    await verify({state,storage,directory,create,close:()=>hook()});
    t.diagnostic(JSON.stringify({pure_module_seam:true,launch_calls:state.launchCalls,storage_close_calls:state.storageCloseCalls,client_end_calls:state.clientEndCalls,external_processes:0,postgres_connections:0}));
  }finally{
    // 这里只清本纯接缝生成的临时普通文件，未创建真实数据库或进程。
    await rm(directory,{recursive:true,force:true});
    assert.equal(await exists(directory),false);
  }
}

for(const active of [0,1])test(`启动清理失败且无handle：active=${active}也必须保留库目录并关闭自有client`,async t=>{
  await withFixture(t,{launchFails:true,active},async({state,directory,create,close})=>{
    await assert.rejects(create(),error=>error===state.originalError);
    let failure;
    await assert.rejects(close(),error=>{failure=error;return true;});
    await assert.rejects(close(),error=>error===failure);
    assert.equal(state.launchCalls,1);assert.equal(state.storageCloseCalls,0);
    assert.equal(state.clientEndCalls,1);assert.equal(await exists(directory),true);
  });
});

test('启动前业务准备失败：未尝试launch时仍可释放自有存储',async t=>{
  await withFixture(t,{failBeforeLaunch:true},async({state,directory,create,close})=>{
    await assert.rejects(create(),error=>error===state.originalError);
    await close();await close();
    assert.equal(state.launchCalls,0);assert.equal(state.storageCloseCalls,1);
    assert.equal(state.clientEndCalls,1);assert.equal(await exists(directory),false);
  });
});

test('已有handle且确认退出：原正常关闭路径保留',async t=>{
  await withFixture(t,{},async({state,directory,create,close})=>{
    await create();await close();await close();
    assert.equal(state.storageCloseCalls,1);assert.equal(state.alive,false);
    assert.equal(await exists(directory),false);
  });
});

test('已有handle且active=1：保留原断言对象同时回收自有存储',async t=>{
  await withFixture(t,{active:1},async({state,directory,create,close})=>{
    await create();let failure;
    await assert.rejects(close(),error=>{failure=error;return error.code==='ERR_ASSERTION'&&error.actual===1&&error.expected===0;});
    await assert.rejects(close(),error=>error===failure);
    assert.equal(state.storageCloseCalls,1);assert.equal(state.alive,false);
    assert.equal(await exists(directory),false);
  });
});

test('已有handle但退出未确认：只关自有client并保留现场',async t=>{
  await withFixture(t,{stopConfirmed:false},async({state,directory,create,close})=>{
    await create();await assert.rejects(close());
    assert.equal(state.storageCloseCalls,0);assert.equal(state.clientEndCalls,1);
    assert.equal(await exists(directory),true);
  });
});
