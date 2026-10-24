/** 真正启动原Python后台；只用本机HTTP/Unix/独占PG，不启动桌面App。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,symlink,copyFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {HostStorage} from '../src/host-storage.ts';
import {startHostModelRuntime} from '../src/host-model-runtime.ts';
import {LegacyBackend} from '../src/legacy-backend.ts';
import {createUnconfiguredFixture} from './host-model-unconfigured-fixture.mjs';

for(const missing of ['key','owner'])test(`原Python后台在TS缺${missing}时真实启动管理、生成503且零模型调用`,{timeout:60000},async t=>{
 const f=await createUnconfiguredFixture(),business=join(f.directory,'business'),home=join(f.directory,'profile');
 await mkdir(business,{mode:0o700});await mkdir(home,{mode:0o700});let storage,runtime,legacy;
 const server=createServer((req,res)=>void(async()=>{if(!runtime||!await runtime.handle(req,res))res.writeHead(404).end('{}');})());
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{try{if(runtime)await runtime.close(async()=>{await legacy?.stop();});else await legacy?.stop();}
  finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await storage?.close();await f.close();}});
 let contents=`NOTALONE_DATABASE_URL=host=/tmp dbname=${f.database}\nNOTALONE_REPLY_RUNTIME=typescript\n`;
 if(missing==='key'){
  const owner=randomUUID();await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')",[owner]);
  contents+=`NOTALONE_OWNER_ID=${owner}\n`;
 }else contents+='NOTALONE_DEEPSEEK_API_KEY=synthetic-only\n';
 await writeFile(f.envFilePath,contents);storage=await HostStorage.open(f.options);
 runtime=await startHostModelRuntime({ctx:new Proxy({},{get(){throw Error('缺项不应安装模型');}}),storage,
  environment:storage.runtimeEnvironment(),businessHome:business,projectDirectory:new URL('../../',import.meta.url).pathname,
  infoPath:join(f.directory,'backend.info'),envFilePath:f.envFilePath});
 const environment={...storage.runtimeEnvironment(),...runtime.pythonEnvironment(`http://127.0.0.1:${server.address().port}`)};
 const project=join(f.directory,'python-project'),source=join(project,'backend/src');
 await mkdir(source,{recursive:true});
 await symlink(new URL('../../backend/src/notalone',import.meta.url).pathname,join(source,'notalone'),'dir');
 await copyFile(new URL('./host-model-unconfigured-network.py',import.meta.url),join(source,'sitecustomize.py'));
 const networkAudit=join(f.directory,'network-audit');environment.NOTALONE_SYNTHETIC_NETWORK_AUDIT=networkAudit;
 let unexpectedExit=false;
 legacy=await LegacyBackend.start({pythonExecutable:process.env.NOTALONE_TEST_PYTHON??join(homedir(),'miniconda3/envs/NotAlone/bin/python'),
  projectDirectory:project,businessHome:business,home,
  envFilePath:f.envFilePath,lockNonce:randomUUID()},environment,()=>{unexpectedExit=true;});
 assert.equal((await legacy.control('/api/runtime/status','GET')).state,'running');
 const fields=Object.fromEntries((await readFile(join(home,'legacy.info'),'utf8')).trim().split('\n').map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
 const response=await fetch(`http://${fields.address}/api/reply/generate`,{method:'POST',
  headers:{Authorization:`Bearer ${fields.token}`,'content-type':'application/json'},body:'{}'});
 assert.equal(response.status,503);assert.equal((await response.json()).error,missing==='key'?'reply_unavailable':'owner_uninitialized');
 assert.equal((await f.client.query('SELECT count(*)::int n FROM model_call_receipt')).rows[0].n,0);
 await assert.rejects(stat(networkAudit),{code:'ENOENT'});
 assert.equal(unexpectedExit,false);
});
