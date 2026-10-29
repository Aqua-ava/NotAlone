import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {access} from 'node:fs/promises';
import {fixture,owner} from './fixtures/memory-sqlite/support.mjs';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';
import {resolveHostReplyConfiguration} from '../src/host/host-reply-config.ts';
import {createSqliteMemoryRuntime} from '../src/memory/sqlite/runtime.ts';

test('共享模型装配不再建host或adapter，关闭只排空本记忆业务且保留宿主和存储',{timeout:10000},async t=>{
 let runtime;t.after(()=>runtime?.close());
 const f=await fixture(t);let registrations=0,disposals=0;
 const configuration=resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY:'synthetic-only'});
 const permit={path:join(f.root,'host-owned.sock'),token:'synthetic-host-token'};
 const provider={beginCall(){throw Error('不得发送');},beginStrictVerificationCall(){throw Error('不得发送');},dispose:async()=>{disposals++;}};
 runtime=await createSqliteMemoryRuntime({ctx:{llm:{registerAdapter(){registrations++;return ()=>{};}}},storage:f.storage,ownerId:owner,userData:f.root,businessHome:f.root,infoPath:join(f.root,'info'),envFilePath:join(f.root,'unused-env'),environment:{},holders:new ActiveHolders(),authorize:()=>false,sharedModel:{configuration,provider,permit,resolveUserId:()=> 'synthetic-host-identity'}});
 assert.equal(runtime.configurationState,'configured');assert.equal(registrations,0,'不得重复安装同名adapter');
 await runtime.close();await runtime.close();assert.equal(disposals,0);
 await assert.rejects(access(join(f.root,'model-permits')),{code:'ENOENT'});
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
 await assert.rejects(runtime.service.start('after-runtime-close'),{code:'memory_extraction_closed'});
});
