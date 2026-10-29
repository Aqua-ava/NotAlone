import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteContactService} from '../src/contacts/sqlite/service.ts';

const owner='00000000-0000-4000-8000-000000000061';
const evidence={externalKey:'synthetic-account',identityScheme:'wechat.account.v1',sourceGeneration:'source-1',assurance:'verified',supportProfile:'synthetic-metadata-v1'};
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function fixture(t,channel){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-contact-close-')));
 const storage=await SqliteStorage.open({userData:root,intent:'create',role:'test'});
 t.after(async()=>{await storage.close();await rm(root,{recursive:true,force:true});});
 const service=new SqliteContactService(storage,owner,channel);await service.initialize();return {service,storage};
}

test('关闭联系人服务等待在途账号读取结算，不把metadata.close返回当释放完成',async t=>{
 const pending=deferred(),started=deferred();
 const {service}=await fixture(t,{account:()=>{started.resolve();return pending.promise;},sessions:async()=>[],close:async()=>{}});
 const reading=service.detectAccount();const cancelled=assert.rejects(reading,{code:'identity_cancelled'});
 await started.promise;
 let completed=false;const closing=service.close().then(()=>{completed=true;});
 try{await setImmediate();assert.equal(completed,false);}
 finally{pending.resolve(evidence);await cancelled;await closing;}
});

test('关闭等待在途名单结算并撤销旧预览，关闭后不再读取metadata',async t=>{
 const channel={account:async()=>evidence,sessions:async()=>[{externalKey:'synthetic-friend',displayName:'合成联系人',kind:'private',identityAssurance:'verified'}],close:async()=>{}};
 const {service}=await fixture(t,channel);
 const candidate=await service.detectAccount();await service.confirmAccount(candidate.candidate_token);
 const snapshot=await service.candidates(true);
 const pending=deferred(),started=deferred();
 channel.sessions=()=>{started.resolve();return pending.promise;};
 const reading=service.candidates(true),cancelled=assert.rejects(reading,{code:'identity_cancelled'});
 await started.promise;
 let completed=false;const closing=service.close().then(()=>{completed=true;});
 try{await setImmediate();assert.equal(completed,false);}
 finally{pending.resolve([]);await cancelled;await closing;}
 channel.account=channel.sessions=async()=>{throw new Error('关闭后不得调用metadata');};
 await assert.rejects(service.detectAccount(),{code:'identity_closed'});
 await assert.rejects(service.candidates(true),{code:'identity_closed'});
 await assert.rejects(service.confirmAccount(candidate.candidate_token),{code:'account_candidate_stale'});
 await assert.rejects(service.confirm(snapshot.snapshot_token,[{locator:'synthetic-friend',observed_display_name:'合成联系人',expected_selection_generation:'0'}]),{code:'selection_stale'});
});

test('metadata明确关闭失败可重试，重试仍等待原读取结算',async t=>{
 const pending=deferred(),started=deferred();let attempts=0;
 const {service}=await fixture(t,{account:()=>{started.resolve();return pending.promise;},sessions:async()=>[],close:async()=>{if(++attempts===1)throw new Error('合成暂时关闭失败');}});
 const reading=service.detectAccount(),cancelled=assert.rejects(reading,{code:'identity_cancelled'});
 await started.promise;
 await assert.rejects(service.close(),/合成暂时关闭失败/);
 let completed=false;const closing=service.close().then(()=>{completed=true;});
 try{await setImmediate();assert.equal(completed,false);assert.equal(attempts,2);}
 finally{pending.resolve(evidence);await cancelled;await closing;}
});
