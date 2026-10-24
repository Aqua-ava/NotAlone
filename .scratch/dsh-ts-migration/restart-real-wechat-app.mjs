// 复用同一临时库/用户目录的重启验收；不创建新授权，不负责删除主夹具。
import {spawn} from 'node:child_process';
import {readFile,writeFile,open} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
const metadataPath='/tmp/notalone-dsh-real-acceptance-session.json';
const metadata=JSON.parse(await readFile(metadataPath,'utf8'));
if(!/^notalone_ts_host_.*_test$/.test(metadata.database))throw Error('拒绝非本轮测试库');
const desktop=join(metadata.project,'desktop');
const {developmentProcesses,requireDevelopmentOnly}=await import(pathToFileURL(join(desktop,'scripts/development-policy.mjs')));
const previous=await developmentProcesses(desktop,metadata.userData);requireDevelopmentOnly(previous);
if(previous.development.length)throw Error('已存在本轮开发实例');
const python=join(homedir(),'miniconda3/envs/NotAlone/bin/python');
const environment=Object.fromEntries(['PATH','HOME','TMPDIR','LANG','TZ','USER','LOGNAME'].flatMap(key=>process.env[key]?[[key,process.env[key]]]:[]));
environment.PATH=dirname(process.execPath)+':'+dirname(python)+':'+(environment.PATH||'/usr/bin:/bin');
const log=await open(join(metadata.directory,'dev-restart.log'),'a',0o600);
const child=spawn(process.execPath,[join(dirname(dirname(python)),'lib/node_modules/npm/bin/npm-cli.js'),'run','dev','--','--user-data-dir',metadata.userData],{cwd:desktop,env:environment,detached:true,stdio:['ignore',log.fd,log.fd]});
const stopped=new Promise((resolve,reject)=>{child.once('error',()=>reject(Error('重启开发实例失败')));child.once('exit',code=>resolve(code));});
const stop=()=>{if(child.exitCode===null&&child.pid){try{process.kill(-child.pid,'SIGINT');}catch(error){if(error.code!=='ESRCH')throw error;}}};
process.once('SIGINT',stop);process.once('SIGTERM',stop);
await log.close();
await writeFile(metadataPath,JSON.stringify({...metadata,restartRunner:child.pid}),{mode:0o600});
console.log(JSON.stringify({event:'same_fixture_restart_started'}));
const code=await stopped;
let groupGone=false;try{process.kill(-child.pid,0);}catch(error){groupGone=error.code==='ESRCH';}
console.log(JSON.stringify({event:'same_fixture_restart_exited',code,npm_group_gone:groupGone}));
process.exitCode=code===0&&groupGone?0:1;
