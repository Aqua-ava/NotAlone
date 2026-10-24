// 仅准备合成数据与npm开发实例；所有页面操作由Computer Use执行。
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdir,writeFile,open,rm} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
const root=resolve(process.env.NOTALONE_ACCEPTANCE_PROJECT_DIRECTORY??'');
if(!process.env.NOTALONE_ACCEPTANCE_PROJECT_DIRECTORY)throw Error('缺少隔离源码路径');
const desktop=join(root,'desktop');
const {developmentProcesses,requireDevelopmentOnly}=await import(pathToFileURL(join(desktop,'scripts/development-policy.mjs')));
const previous=await developmentProcesses(desktop);requireDevelopmentOnly(previous);
if(previous.development.length)throw Error('已有开发实例，保留现场');
const cleanups=[];
const {createForegroundFixture}=await import(pathToFileURL(join(root,'backend-ts/test/foreground-location-fixture.mjs')));
const f=await createForegroundFixture({after:callback=>cleanups.push(callback)},{launch:false});
let runner,runnerExited=false;
const sessionPath='/tmp/notalone-dsh-host-acceptance-session.json';
try{
  const {HostStorage}=await import(pathToFileURL(join(root,'backend-ts/src/host-storage.ts')));
  const {MemoryService}=await import(pathToFileURL(join(root,'backend-ts/src/memory-service.ts')));
  const storage=await HostStorage.open(f.options);
  let memory;
  try{memory=await new MemoryService(storage).handle('POST',new URL('http://localhost/api/memories/manual-contact'),{contact_id:f.contact,text:'合成验收资料：喜欢清淡食物',category:'preference'});}
  finally{await storage.close();}
  const userData=join(f.directory,'desktop');await mkdir(userData,{recursive:true});
  const infoPath=join(f.directory,'backend.info');
  const python=join(homedir(),'miniconda3/envs/NotAlone/bin/python');
  await writeFile(join(userData,'backend-launch.json'),JSON.stringify({pythonExecutable:python,projectDirectory:root,envFilePath:f.envFilePath,backendInfoPath:infoPath,wechatCliPath:f.cli,syncProbePath:f.probe}),{mode:0o600});
  const environment=Object.fromEntries(['PATH','HOME','TMPDIR','LANG','TZ','USER','LOGNAME'].flatMap(key=>process.env[key]?[[key,process.env[key]]]:[]));
  environment.PATH=dirname(process.execPath)+':'+dirname(python)+':'+(environment.PATH??'/usr/bin:/bin');
  const log=await open(join(f.directory,'dev.log'),'a',0o600);
  runner=spawn(process.execPath,[join(dirname(dirname(python)),'lib/node_modules/npm/bin/npm-cli.js'),'run','dev','--','--user-data-dir',userData],{cwd:desktop,env:environment,stdio:['ignore',log.fd,log.fd]});
  await log.close();
  runner.on('exit',code=>{runnerExited=true;console.log('开发实例退出',code);});
  await writeFile(sessionPath,JSON.stringify({directory:f.directory,userData,infoPath,database:f.client.database,owner:f.owner,contact:f.contact,binding:f.binding,memory:memory.memory.memory_id,runner:runner.pid,project:root}),{mode:0o600});
  console.log('合成开发实例已启动；会话元数据仅存本机临时文件');
  for await(const line of createInterface({input:process.stdin})){
    if(line==='status')console.log(JSON.stringify(await developmentProcesses(desktop,userData)));
    else if(line==='stop')runner.kill('SIGINT');
    else if(line==='cleanup'){
      if(!runnerExited){console.log('开发实例仍在运行，拒绝清理');continue;}
      break;
    }
  }
}finally{
  if(runner&&!runnerExited)runner.kill('SIGINT');
  if(runner&&!runnerExited){
    let timer;
    try{await Promise.race([new Promise(resolve=>runner.once('exit',resolve)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('开发实例退出超时，保留现场')),10000);})]);}
    finally{clearTimeout(timer);}
  }
  for(const cleanup of cleanups.reverse())await cleanup();
  await rm(sessionPath,{force:true});
  console.log('合成数据库与开发目录已清理');
  process.stdin.pause();
}
