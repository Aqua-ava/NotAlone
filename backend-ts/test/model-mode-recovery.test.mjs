/** 当前 Node ModelHost 拒绝损坏 journal；旧 Python 回退门禁仅保留在固定 Git 历史入口。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startModelHost} from '../src/model-host.ts';
async function options(t){const home=await mkdtemp(join(tmpdir(),'na-fallback-'));t.after(()=>rm(home,{recursive:true,force:true}));return {businessHome:home,infoPath:join(home,'backend.info'),envFilePath:join(home,'synthetic.env'),runtimeEnvironment:{}};}
async function realClosed(t){const config=await options(t),host=await startModelHost(config);const path=host.statePath;await host.close(async()=>{});return {config,path};}
for(const kind of ['null','缺host','unknown错误结算'])test('TS opener共享parser拒绝'+kind+'且不覆盖journal',async t=>{
 const {config,path}=await realClosed(t);let body=kind==='null'?'null':JSON.stringify({version:1,active:[],unknown:[]});
 if(kind==='unknown错误结算'){
  const {captureProcessIdentity}=await import('../src/process-identity.ts');
  const worker=await captureProcessIdentity(process.pid,process.ppid,process.execPath);
  body=JSON.stringify({version:1,host:null,active:[],unknown:[{id:'synthetic-permit',kind:'background',worker,settlement:'settled'}]});
 }
 await writeFile(path,body);await assert.rejects(startModelHost(config),/model_permit_journal_invalid/);assert.equal(await readFile(path,'utf8'),body);
});
