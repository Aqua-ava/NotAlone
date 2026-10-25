import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,mkdir,writeFile,readFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {managedLayout,requiredRuntimeFiles} from '../managed-runtime-contract.mjs';
import {HostStorage} from '../../backend-ts/src/host-storage.ts';
const pgBin=process.env.NOTALONE_TEST_PG_BIN??path.join(homedir(),'miniconda3/envs/NotAlone/bin');
test('全新受管库经TS监督和原迁移首次准备，PATH无Conda且拒绝任何Python调用',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'notalone-managed-ts-')),resources=path.join(directory,'resources'),root=path.join(resources,'notalone-runtime'),userData=path.join(directory,'user');
 let runtime;
 await mkdir(root,{recursive:true});t.after(async()=>{await runtime?.stop();await rm(directory,{recursive:true,force:true});});
 const entries=[];
 async function add(relative,bytes,executable=false){const selected=path.join(root,relative);await mkdir(path.dirname(selected),{recursive:true});await writeFile(selected,bytes,{mode:executable?0o700:0o600});entries.push({path:relative,sha256:createHash('sha256').update(bytes).digest('hex'),...(executable?{executable:true}:{})});}
 const marker=path.join(directory,'python-was-invoked');
 for(const relative of requiredRuntimeFiles){
  if(relative===managedLayout.python)await add(relative,`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected');process.exit(99);\n`,true);
  else if(relative.startsWith('postgres/')){const executable=path.join(pgBin,path.basename(relative));await add(relative,`#!/bin/sh\nexec '${executable.replaceAll("'","'\\''")}' "$@"\n`,true);}
  else await add(relative,'# 合成旧组件，纯 TS 不执行。\n');
 }
 const schema=await build({entryPoints:['../backend-ts/src/schema-prepare-cli.ts'],bundle:true,platform:'node',format:'esm',write:false,banner:{js:"import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);"}});
 await add('project/backend-ts/src/schema-prepare-cli.ts',schema.outputFiles[0].contents);
 for(const module of ['managed-postgres.ts','managed-database-lifetime.ts'])await add(`project/backend-ts/src/${module}`,await readFile(path.resolve('../backend-ts/src',module)));
 await add('project/backend-ts/src/launch.ts','// 合成构件入口。\n');await add('project/backend-ts/profile/host.patch.yml','[]\n');
 const {readdir}=await import('node:fs/promises');
 for(const name of await readdir('../backend/database/migrations'))if(name.endsWith('.sql'))await add(`project/backend/database/migrations/${name}`,await readFile(path.join('../backend/database/migrations',name)));
 await writeFile(path.join(root,'manifest.json'),JSON.stringify({formatVersion:1,architecture:process.arch,paths:managedLayout,components:[1,2].map(n=>({name:`synthetic-${n}`,version:'test',source:'repository:synthetic',sha256:'a'.repeat(64)})),files:entries}));
 const subject=await build({stdin:{contents:"export {ManagedRuntime} from './src/main/startup/managed-runtime.ts'; export {loadBackendConfiguration} from './src/main/backend/config.ts';",resolveDir:path.resolve('.')},bundle:true,platform:'node',format:'esm',write:false});
 const subjectPath=path.join(directory,'subject.mjs');await writeFile(subjectPath,subject.outputFiles[0].text);const {ManagedRuntime,loadBackendConfiguration}=await import(subjectPath);
 const prior=process.env.NOTALONE_HOST_RUNTIME;process.env.NOTALONE_HOST_RUNTIME='typescript';
 runtime=new ManagedRuntime(userData,resources,()=>{});
 try{
  await runtime.prepare(()=>true);const config=await loadBackendConfiguration(userData,resources);
  assert.equal(config.runtime,'dsh');assert.equal(config.pythonExecutable,undefined);
  await runtime.start(config,()=>true);
  assert.equal(await readFile(marker,'utf8').catch(()=>''),'');
  const storage=await HostStorage.open({envFilePath:config.envFilePath,migrationsDirectory:path.join(root,'project/backend/database/migrations'),environment:{}});
  try{assert.deepEqual(await storage.compatibility(),{code:'ready'});assert.equal((await storage.setupStatus()).initialized,false);}finally{await storage.close();}
  assert.ok(config.managedLifetimeLock);assert.equal(await runtime.stop(),true);
 }finally{if(prior===undefined)delete process.env.NOTALONE_HOST_RUNTIME;else process.env.NOTALONE_HOST_RUNTIME=prior;}
});
