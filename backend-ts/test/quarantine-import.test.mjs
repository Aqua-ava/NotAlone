import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {importSelectedQuarantine} from '../src/history/quarantine-import.ts';

const row=id=>({partition:'p',table:'t',localId:id,serverId:'0',sender:'contact',kind:'text',text:`合成待核验${id}`,originalType:'1',status:'99',stateAssurance:'unverified',sentAt:null,timePrecision:null,orderScheme:null,orderKey:null});
function channel({fail=false,forged=false}={}){
 let closed=false,pages=0;const target={protocol:'private-history-v1',descriptor:'snapshot',partitions:['p'],tables:[{partition:'p',instance:'t'}],sourceGeneration:'source'};
 return {get closed(){return closed;},get pages(){return pages;},
 accountMetadata:async()=>({status:'verified',accountKey:'account',sourceGeneration:'source'}),
 resolveSelected:async name=>({accountKey:'account',conversationKey:'contact',displayName:name,sourceGeneration:'source'}),
 inspectSelected:async()=>({checkedPartitions:['p'],tables:[{partition:'p',target:'t'}]}),
 supportSelected:async()=>({status:'unverified',profileId:'synthetic',capabilities:{programVersion:'supported',exactSchema:'supported',declaredLocalKey:'supported'}}),
 quarantineTargetSelected:async()=>target,
 quarantinePageSelected:async(_target,cursor)=>{pages++;if(fail&&pages===2)throw Object.assign(new Error('private-details-must-not-persist'),{code:typeof fail==='string'?fail:'history_source_changed'});return {kind:'quarantine',page:{target:'snapshot',cursorIn:cursor,cursorOut:pages===1?'next':null,records:[{...row(String(pages)),...(forged?{stateAssurance:'verified'}:{})}],completedPartitions:pages===1?[]:['p'],exhausted:pages===2}};},
 close:async()=>{closed=true;}};
}
async function root(t){const dir=await mkdtemp(join(tmpdir(),'notalone-quarantine-import-'));t.after(()=>rm(dir,{recursive:true,force:true}));return join(dir,'vault');}

test('单联系人固定快照完整遍历后仅保存未核验文字，不获得普通历史资格',async t=>{
 const client=channel(),vault=await importSelectedQuarantine(client,{displayName:'合成联系人',root:await root(t)});t.after(()=>vault.close());
 assert.equal(client.closed,true);assert.equal(client.pages,2);assert.equal(vault.summary().snapshotComplete,true);
 assert.equal(vault.summary().normalHistory,false);assert.equal(vault.list({limit:10}).records.length,2);
 assert.ok(vault.list({limit:10}).records.every(r=>r.state==='unverified'));
});

test('来源失证时停止继续分页，保留隔离内容并明确快照不完整',async t=>{
 for(const code of ['history_source_changed','history_native_unavailable']){
 const client=channel({fail:code});let saved;
 await assert.rejects(importSelectedQuarantine(client,{displayName:'合成联系人',root:await root(t),onVault:v=>{saved=v;}}),{code});
 t.after(()=>saved.close());assert.equal(client.closed,true);assert.equal(saved.summary().snapshotComplete,false);
 assert.equal(saved.summary().failureCode,'source_continuity_lost');assert.equal(saved.list({limit:10}).records.length,1);
 }
});

test('隔离导入拒绝伪造已认证记录并排空渠道',async t=>{
 const client=channel({forged:true});let saved;
 await assert.rejects(importSelectedQuarantine(client,{displayName:'合成联系人',root:await root(t),onVault:v=>{saved=v;}}),{code:'quarantine_page_invalid'});
 t.after(()=>saved.close());assert.equal(client.closed,true);assert.equal(saved.list({limit:10}).records.length,0);
});
