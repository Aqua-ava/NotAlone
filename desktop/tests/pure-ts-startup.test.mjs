import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,mkdir,writeFile,rm,realpath,readFile} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import path from 'node:path';
import {syntheticDshProject} from './helpers/synthetic-dsh-project.mjs';
const directory=await mkdtemp(path.join(tmpdir(),'notalone-pure-ts-startup-'));
const built=await build({stdin:{contents:"export * from './src/main/backend/config.ts'; export {OwnedBackendProcess} from './src/main/backend/process.ts';",resolveDir:path.resolve('.')},bundle:true,platform:'node',format:'esm',write:false});
await writeFile(path.join(directory,'config.mjs'),built.outputFiles[0].text);
const {validateLaunchConfiguration,wechatConfigurationPath,loadBackendConfiguration,configureDevelopmentProject,saveBackendConfiguration,configurationPaths,OwnedBackendProcess}=await import(path.join(directory,'config.mjs'));
after(()=>rm(directory,{recursive:true,force:true}));
test('微信配置路径在隔离宿主启动前确定，并保留用户显式配置', () => {
 const previous = [process.env.WECHAT_CLI_CONFIG, process.env.WX_MCP_CONFIG];
 try {
  delete process.env.WECHAT_CLI_CONFIG; delete process.env.WX_MCP_CONFIG;
  assert.equal(wechatConfigurationPath(),path.join(homedir(),'.config','wxcli','config.json'));
  process.env.WECHAT_CLI_CONFIG='/synthetic/existing-account.json';
  assert.equal(wechatConfigurationPath(),'/synthetic/existing-account.json');
 } finally {
  for(const [index,key] of ['WECHAT_CLI_CONFIG','WX_MCP_CONFIG'].entries()) {if(previous[index]===undefined)delete process.env[key];else process.env[key]=previous[index];}
 }
});
test('默认开发配置只走SQLite启动路径，旧字段被忽略且子进程不继承PG配置',async()=>{
 const projectDirectory=path.join(directory,'project');
 const executable=await syntheticDshProject(projectDirectory);
 const inherited = { NOTALONE_HOST_RUNTIME: 'synthetic-retired-host', NOTALONE_DATABASE_URL: 'synthetic-database', PGPASSWORD: 'synthetic-secret', WECHAT_CLI_WCDB_LIB: '/synthetic/wcdb' };
 const previous = Object.fromEntries(Object.keys(inherited).map(key => [key, process.env[key]]));
 Object.assign(process.env, inherited);
 try{
  configureDevelopmentProject(projectDirectory);
  const userData=path.join(directory,'user-data');await mkdir(userData);
  await writeFile(path.join(userData,'backend-launch.json'),JSON.stringify({projectDirectory,backendInfoPath:path.join(userData,'managed/sqlite-backend.info'),envFilePath:path.join(userData,'synthetic.env')}));
  const config=await loadBackendConfiguration(userData);
  assert.equal(config.runtime,'dsh');
  assert.deepEqual(await validateLaunchConfiguration(config),{projectDirectory:await realpath(projectDirectory)});
  const file=path.join(userData,'backend-launch.json'),original=await readFile(file,'utf8');
  for(const pythonExecutable of ['/synthetic/missing-python', 'python', {retired:true}]){
   await writeFile(file,JSON.stringify({...JSON.parse(original),pythonExecutable}));
   const legacy=await loadBackendConfiguration(userData);
   assert.equal(legacy.pythonExecutable,undefined);
   assert.deepEqual(await validateLaunchConfiguration(legacy),{projectDirectory:await realpath(projectDirectory)});
  }
  await saveBackendConfiguration(userData,{...configurationPaths(config),pythonExecutable:'/synthetic/missing-python'},()=>true);
  assert.equal('pythonExecutable' in JSON.parse(await readFile(file,'utf8')),false);
  config.syncProbePath=path.join(userData,'configured-probe');
  const observed=path.join(userData,'child-environment.json');
  await writeFile(executable,`require('node:fs').writeFileSync(${JSON.stringify(observed)},JSON.stringify({host:process.env.NOTALONE_HOST_RUNTIME??null,databaseUrl:process.env.NOTALONE_DATABASE_URL??null,pgpassword:process.env.PGPASSWORD??null,wcdb:process.env.WECHAT_CLI_WCDB_LIB??null,probe:process.env.NOTALONE_SYNC_PROBE??null,wechatConfig:process.env.NOTALONE_WECHAT_CONFIG??null,homeIsolated:process.env.HOME!==${JSON.stringify(homedir())}}));\n`);
  const child=await OwnedBackendProcess.launch({...config, sqlite:{userData,expectedDatabaseId:'synthetic-instance-id',role:'test'}},()=>true);
  assert.equal(await child.waitForExit(5000),true);
  assert.deepEqual(JSON.parse(await readFile(observed,'utf8')),{host:null,databaseUrl:null,pgpassword:null,wcdb:null,probe:config.syncProbePath,wechatConfig:wechatConfigurationPath(),homeIsolated:true});
 }finally{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
