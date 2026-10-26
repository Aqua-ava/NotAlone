import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,mkdir,writeFile,rm,realpath,symlink,readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
const directory=await mkdtemp(path.join(tmpdir(),'notalone-pure-ts-startup-'));
const built=await build({stdin:{contents:"export * from './src/main/backend/config.ts'; export {OwnedBackendProcess} from './src/main/backend/process.ts'; export {StartupDiagnostics} from './src/main/startup/diagnostics.ts';",resolveDir:path.resolve('.')},bundle:true,platform:'node',format:'esm',write:false});
await writeFile(path.join(directory,'config.mjs'),built.outputFiles[0].text);
const {validateLaunchConfiguration,backendEnvironment,loadBackendConfiguration,configureDevelopmentProject,saveBackendConfiguration,configurationPaths,StartupDiagnostics,OwnedBackendProcess}=await import(path.join(directory,'config.mjs'));
after(()=>rm(directory,{recursive:true,force:true}));
test('默认开发配置无需选择标记或Python，兼容失效旧字段并实际启动Node子进程',async()=>{
 const projectDirectory=path.join(directory,'project');
 await mkdir(path.join(projectDirectory,'backend-ts/src'),{recursive:true});
 await mkdir(path.join(projectDirectory,'backend-ts/profile'),{recursive:true});
 await writeFile(path.join(projectDirectory,'backend-ts/src/launch.ts'),'// 合成入口\n');
 await writeFile(path.join(projectDirectory,'backend-ts/profile/host.patch.yml'),'[]\n');
 const prior=process.env.NOTALONE_HOST_RUNTIME;delete process.env.NOTALONE_HOST_RUNTIME;
 try{
  configureDevelopmentProject(projectDirectory);
  const userData=path.join(directory,'user-data');await mkdir(userData);
  await writeFile(path.join(userData,'backend-launch.json'),JSON.stringify({projectDirectory,backendInfoPath:path.join(userData,'backend.info'),envFilePath:path.join(userData,'synthetic.env')}));
  const config=await loadBackendConfiguration(userData);
  assert.equal(config.runtime,'dsh');
  assert.deepEqual(await validateLaunchConfiguration(config),{projectDirectory:await realpath(projectDirectory)});
  assert.equal(backendEnvironment(config,userData).NOTALONE_HOST_RUNTIME,undefined);
  const file=path.join(userData,'backend-launch.json'),original=await readFile(file,'utf8');
  for(const pythonExecutable of ['/synthetic/missing-python', 'python', {retired:true}]){
   await writeFile(file,JSON.stringify({...JSON.parse(original),pythonExecutable}));
   const legacy=await loadBackendConfiguration(userData);
   assert.equal(legacy.pythonExecutable,undefined);
   assert.deepEqual(await validateLaunchConfiguration(legacy),{projectDirectory:await realpath(projectDirectory)});
  }
  await saveBackendConfiguration(userData,{...configurationPaths(config),pythonExecutable:'/synthetic/missing-python'},()=>true);
  assert.equal('pythonExecutable' in JSON.parse(await readFile(file,'utf8')),false);
  const executable=path.join(projectDirectory,'backend-ts/node_modules/@deepseek-ai/dsh/lib/bin.js'),observed=path.join(userData,'child-environment.json'),lifetime=path.join(userData,'synthetic-lifetime');
  await mkdir(path.dirname(executable),{recursive:true});
  await writeFile(executable,`require('node:fs').writeFileSync(${JSON.stringify(observed)},JSON.stringify({host:process.env.NOTALONE_HOST_RUNTIME,lifetime:process.env.NOTALONE_MANAGED_LIFETIME_LOCK}));\n`);
  const child=await OwnedBackendProcess.launch({...config,managedLifetimeLock:lifetime},()=>true);
  assert.equal(await child.waitForExit(5000),true);
  assert.deepEqual(JSON.parse(await readFile(observed,'utf8')),{lifetime});
  assert.deepEqual(await validateLaunchConfiguration({...config,runtime:undefined}),{projectDirectory:await realpath(projectDirectory)});
 }finally{if(prior===undefined)delete process.env.NOTALONE_HOST_RUNTIME;else process.env.NOTALONE_HOST_RUNTIME=prior;}
});
test('纯 TS 诊断在没有Python与旧源码时沿同一空库准备schema并复验',async t=>{
 const pg=createRequire(new URL('../../backend-ts/package.json',import.meta.url))('pg');
 const name=`notalone_desktop_schema_${randomUUID().replaceAll('-','')}_test`,admin=new pg.Client({host:'/tmp',database:'postgres'});await admin.connect();
 await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
 t.after(async()=>{await admin.query(`DROP DATABASE "${name}"`);await admin.end();});
 const userData=path.join(directory,'diagnostic'),projectDirectory=path.join(userData,'project'),infoPath=path.join(userData,'backend.info');
 await mkdir(path.join(projectDirectory,'backend/database'),{recursive:true});
 await symlink(path.resolve('../backend-ts'),path.join(projectDirectory,'backend-ts'),'dir');
 await symlink(path.resolve('../backend/database/migrations'),path.join(projectDirectory,'backend/database/migrations'),'dir');
 await writeFile(path.join(userData,'backend-launch.json'),JSON.stringify({projectDirectory,backendInfoPath:infoPath,envFilePath:path.join(userData,'synthetic.env')}));
 const keys=['NOTALONE_HOST_RUNTIME','NOTALONE_DATABASE_URL','NOTALONE_DISABLE_DOTENV','PATH'],prior=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 delete process.env.NOTALONE_HOST_RUNTIME;
 Object.assign(process.env,{NOTALONE_DATABASE_URL:`host=/tmp dbname=${name}`,NOTALONE_DISABLE_DOTENV:'1',PATH:'/usr/bin:/bin'});
 try{
  configureDevelopmentProject(projectDirectory);
  const config=await loadBackendConfiguration(userData),diagnostics=new StartupDiagnostics(userData);
  await diagnostics.ensureReady(config,()=>true).catch(()=>assert.fail(JSON.stringify(diagnostics.getState())));
  assert.equal(diagnostics.getState().code,'ready');
  assert.equal(await readFile(infoPath,'utf8').catch(()=>''),'');
 }finally{for(const key of keys){if(prior[key]===undefined)delete process.env[key];else process.env[key]=prior[key];}}
});
