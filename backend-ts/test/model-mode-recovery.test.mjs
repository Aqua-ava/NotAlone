/** 恢复以SQLite台账为权威，不再解释旧socket journal。 */
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,dirname} from 'node:path';import {startModelHost} from '../src/platform/models/model-host.ts';
test('旧journal不参与新宿主恢复，未知调用继续来自持久账本',async t=>{
 const home=await mkdtemp(join(tmpdir(),'na-model-recovery-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const id='11111111-1111-4111-8111-111111111111',config={businessHome:home,infoPath:join(home,'info'),envFilePath:join(home,'env'),runtimeEnvironment:{},accounting:{reserve:async()=>{},recordReserved:async()=>{},unconfirmedRequests:async()=>[id]}};
 const first=await startModelHost(config),path=join(dirname(first.identityHome),'state.json');await first.close(async()=>{});await writeFile(path,'synthetic-retired-journal');
 const next=await startModelHost(config);assert.deepEqual(await next.permit.unconfirmedRequests({owner_id:id,contact_id:null}),[id]);assert.equal(await readFile(path,'utf8'),'synthetic-retired-journal');await next.close(async()=>{});
});
