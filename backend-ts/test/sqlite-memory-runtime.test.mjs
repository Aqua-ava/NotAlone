import {createBuiltinMemoryContentRegistry} from '../src/memory/content/builtins.ts';
import {createModelPermitPort} from '../src/platform/models/model-permit-port.ts';
import {ModelPermitArbiter} from '../src/platform/models/model-permits.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {access} from 'node:fs/promises';
import {fixture,owner} from './fixtures/memory-sqlite/support.mjs';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';
import {resolveHostReplyConfiguration} from '../src/host/host-reply-config.ts';
import {createSqliteMemoryRuntime} from '../src/memory/sqlite/runtime.ts';

test('共享模型装配不再建host或adapter，关闭只排空本记忆业务且保留宿主和存储',{timeout:10000},async t=>{
 let runtime;t.after(()=>runtime?.close().catch(()=>{}));
 const f=await fixture(t);let registrations=0,disposals=0;
 const configuration=resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY:'synthetic-only'});
 const permit=createModelPermitPort(new ModelPermitArbiter(1));
 const provider={beginCall(){throw Error('不得发送');},beginStrictVerificationCall(){throw Error('不得发送');},dispose:async()=>{disposals++;}};
 runtime=await createSqliteMemoryRuntime({contentRegistry:createBuiltinMemoryContentRegistry(),ctx:{llm:{registerAdapter(){registrations++;return ()=>{};}}},storage:f.storage,ownerId:owner,userData:f.root,businessHome:f.root,infoPath:join(f.root,'info'),envFilePath:join(f.root,'unused-env'),environment:{},holders:new ActiveHolders(),authorize:()=>false,sharedModel:{configuration,provider,permit,resolveUserId:()=> 'synthetic-host-identity'}});
 assert.equal(runtime.configurationState,'configured');assert.equal(registrations,0,'不得重复安装同名adapter');
 const closeService=runtime.service.close.bind(runtime.service);let closeAttempts=0;
 runtime.service.close=async()=>{closeAttempts++;if(closeAttempts===1)throw Error('合成排空失败');await closeService();};
 await assert.rejects(runtime.close(),/合成排空失败/);
 await runtime.close();await runtime.close();assert.equal(disposals,0);
 assert.equal(closeAttempts,2,'失败只重试释放；成功关闭结果继续复用');
 await assert.rejects(access(join(f.root,'model-permits')),{code:'ENOENT'});
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
 await assert.rejects(runtime.service.start('after-runtime-close'),{code:'memory_extraction_closed'});
});

test('独立装配先排空业务，模型释放失败不把自有host提前封死',{timeout:10000},async t=>{
 let runtime;t.after(()=>runtime?.close().catch(()=>{}));const f=await fixture(t);let disposals=0;
 runtime=await createSqliteMemoryRuntime({contentRegistry:createBuiltinMemoryContentRegistry(),ctx:{llm:{registerAdapter:()=>async()=>{if(++disposals===1)throw Error('合成自有adapter释放失败');}}},storage:f.storage,ownerId:owner,userData:f.root,businessHome:f.root,infoPath:join(f.root,'info'),envFilePath:join(f.root,'unused-env'),environment:{NOTALONE_DEEPSEEK_API_KEY:'synthetic-only'},holders:new ActiveHolders(),authorize:()=>false});
 await access(join(f.root,'model-permits'));
 await assert.rejects(runtime.close(),/合成自有adapter释放失败/);
 await assert.rejects(runtime.service.start('no-reopen-owned-runtime'),{code:'memory_extraction_closed'});
 await runtime.close();await runtime.close();assert.equal(disposals,2);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
