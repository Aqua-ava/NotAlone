import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {historyTarget} from '../src/history/sqlite/deletion-target.ts';
import {deletionTargetKey} from '../src/storage/sqlite/deletion/actions.ts';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
const registry=(mode='legacy')=>new URL(`./fixtures/history/source-proof-registry.mjs?mode=${mode}`,import.meta.url).href;
async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-source-proof-')));const storage=await SqliteStorage.open({userData:root,intent:'create',role:'test',registryModule:registry()});
 t.after(async()=>{await storage.close();await rm(root,{recursive:true,force:true});});return {root,storage};
}

test('易失守卫在写事务内可读，并且只在提交成功后对下一动作可见',async t=>{
 const {storage}=await fixture(t),value={binding_id:'binding-a',state:'active'};
 assert.deepEqual(await storage.execute('fixture.runtimeWrite',{key:'a',value}),value);
 assert.deepEqual(await storage.execute('fixture.runtimeRead',{key:'a'}),value);
});


test('独立46迁移折叠旧围栏范围租约，匹配范围才ok且旧围栏保持待确认',async t=>{
 const {root,storage}=await fixture(t);await storage.execute('fixture.seedProofs',{});const id=storage.status.databaseId;await storage.close();
 const next=await SqliteStorage.open({userData:root,intent:'open',role:'test',expectedDatabaseId:id,registryModule:registry('upgrade')});t.after(()=>next.close());
 const after=await next.execute('fixture.proofSnapshot',{});
 assert.deepEqual(after.proofs.map(p=>[p.contact_id,p.state]),[['a','ok'],['b','needs_confirmation'],['c','needs_confirmation']]);
 assert.ok(after.proofs.every(p=>p.checked_at===null),'迁移不能伪造本次核对时间');
 for(const table of ['history_continuity_fence','history_continuity_scope','history_guard_lease'])assert.ok(!after.tables.includes(table));
 assert.deepEqual(await next.check(),{integrity:'ok',foreignKeys:'ok'});
});


for(const failure of ['throw','clone','commit','delete'])test(`易失守卫${failure}失败回滚保留提交前状态`,async t=>{
 const {storage}=await fixture(t);const value={state:'active'};await storage.execute('fixture.runtimeWrite',{key:'a',value});
 await assert.rejects(storage.execute('fixture.runtimeFailure',{key:'a',value:{state:'lost'},failure}));
 assert.deepEqual(await storage.execute('fixture.runtimeRead',{key:'a'}),value);
 assert.deepEqual(await storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('busy重试每次使用新overlay，读动作不能改守卫，引用不会逃逸',async t=>{
 const {storage}=await fixture(t),value={state:'active'};await storage.execute('fixture.runtimeWrite',{key:'a',value});
 assert.deepEqual(await storage.execute('fixture.runtimeFailure',{key:'a',value:{state:'candidate'},failure:'busy'}),{before:value,attempt:2});
 await assert.rejects(storage.execute('fixture.runtimeReadMutation',{key:'a',value:{state:'lost'}}),{code:'runtime_transaction_invalid'});
 assert.deepEqual(await storage.execute('fixture.runtimeRead',{key:'a'}),{state:'candidate'});
 assert.deepEqual(await storage.execute('fixture.runtimeAlias',{key:'b',value}),{state:'mutated-output'});
 assert.deepEqual(await storage.execute('fixture.runtimeRead',{key:'b'}),value);
 assert.equal(await storage.execute('fixture.runtimeRemove',{key:'b'}),null);
});

test('易失守卫不随SQLite重新打开恢复',async t=>{
 const {root,storage}=await fixture(t),id=storage.status.databaseId;
 await storage.execute('fixture.runtimeWrite',{key:'a',value:{state:'active'}});await storage.close();
 const next=await SqliteStorage.open({userData:root,intent:'open',role:'test',expectedDatabaseId:id,registryModule:registry()});t.after(()=>next.close());
 assert.equal(await next.execute('fixture.runtimeRead',{key:'a'}),null);
});


test('46迁移把未完成删除中的旧三类目标按联系人合并为精确source_proof目标',async t=>{
 const {root,storage}=await fixture(t);await storage.execute('fixture.seedProofs',{});await storage.execute('fixture.seedProofDeletion',{});const id=storage.status.databaseId;await storage.close();
 const next=await SqliteStorage.open({userData:root,intent:'open',role:'test',expectedDatabaseId:id,registryModule:registry('upgrade')});t.after(()=>next.close());
 const {targets,operations}=await next.execute('fixture.proofSnapshot',{});
 assert.equal(targets.length,1);assert.equal(targets[0].row_kind,'source_proof');assert.equal(targets[0].state,'pending');
 const target=historyTarget('source_proof',{owner_id:'synthetic-owner',contact_id:'a'});
 assert.deepEqual(JSON.parse(targets[0].target_payload),target);assert.equal(targets[0].target_key,deletionTargetKey(target));
 assert.equal(JSON.parse(targets[0].expected_identity),target.identity);
 assert.equal(operations[0].plan_revision,2n);assert.equal(operations[0].state,'fenced');assert.equal(operations[0].runner_token,null);
 assert.deepEqual(await next.check(),{integrity:'ok',foreignKeys:'ok'});
});


for(const [name,tablesJson]of [
 ['malformed','{'],['empty-partitions',JSON.stringify({accountKey:'account-key-a',partitions:[],tables:[]})],
 ['duplicate-partitions',JSON.stringify({accountKey:'account-key-a',partitions:['p','p'],tables:[['p','table']]})],
 ['bad-table-shape',JSON.stringify({accountKey:'account-key-a',partitions:['p'],tables:['not-a-pair']})],
 ['bad-table-member',JSON.stringify({accountKey:'account-key-a',partitions:['p'],tables:[['other','table']]})],
 ['bad-checked-files',JSON.stringify({accountKey:'account-key-a',partitions:['p'],tables:[['p','table']],checkedPartitions:['other']})],
])test(`未知旧scope(${name})迁移为needs_confirmation而非伪造ok`,async t=>{
 const {root,storage}=await fixture(t);await storage.execute('fixture.seedProofs',{});await storage.execute('fixture.breakProofScope',{tablesJson});const id=storage.status.databaseId;await storage.close();
 const next=await SqliteStorage.open({userData:root,intent:'open',role:'test',expectedDatabaseId:id,registryModule:registry('upgrade')});t.after(()=>next.close());
 const {proofs}=await next.execute('fixture.proofSnapshot',{});assert.equal(proofs.find(p=>p.contact_id==='a').state,'needs_confirmation');
});


test('统一来源围栏保留已知物理事实且重复围栏不重复推进资料修订',async t=>{
 const {root,storage}=await fixture(t);await storage.execute('fixture.seedProofs',{});const id=storage.status.databaseId;await storage.close();
 const next=await SqliteStorage.open({userData:root,intent:'open',role:'test',expectedDatabaseId:id,registryModule:registry('upgrade')});t.after(()=>next.close());
 const old=(await next.execute('fixture.proofSnapshot',{})).proofs.find(p=>p.contact_id==='a');
 const first=await next.execute('fixture.fenceProof',{contactId:'a'});assert.equal(first.blocked,true);assert.equal(first.revision,1n);
 assert.equal(first.proof.tables_json,old.tables_json);assert.equal(first.proof.source_generation,old.source_generation);
 const twice=await next.execute('fixture.fenceProof',{contactId:'a'});assert.equal(twice.revision,1n);
});


test('迁移保留既有SQL校验和、重复打开幂等，旧代码明确schema_too_new',async t=>{
 const {root,storage}=await fixture(t);await storage.execute('fixture.seedProofs',{});const before=await storage.execute('fixture.proofLedger',{}),id=storage.status.databaseId;await storage.close();
 let next=await SqliteStorage.open({userData:root,intent:'open',role:'test',expectedDatabaseId:id,registryModule:registry('upgrade')});
 const first=await next.execute('fixture.proofSnapshot',{});assert.deepEqual(first.ledger.slice(0,45),before);await next.close();
 await assert.rejects(SqliteStorage.open({userData:root,intent:'open',role:'test',expectedDatabaseId:id,registryModule:registry()}),{code:'schema_too_new'});
 next=await SqliteStorage.open({userData:root,intent:'open',role:'test',expectedDatabaseId:id,registryModule:registry('upgrade')});t.after(()=>next.close());
 const again=await next.execute('fixture.proofSnapshot',{});assert.deepEqual(again,first);
});

test('损坏或跨owner的旧删除定位使迁移整体回滚，不删除旧三表',async t=>{
 const {root,storage}=await fixture(t);await storage.execute('fixture.seedProofs',{});await storage.execute('fixture.seedProofDeletion',{});await storage.execute('fixture.corruptProofDeletion',{});
 const before=await storage.execute('fixture.legacyProofSnapshot',{}),id=storage.status.databaseId;await storage.close();
 await assert.rejects(SqliteStorage.open({userData:root,intent:'open',role:'test',expectedDatabaseId:id,registryModule:registry('upgrade')}));
 const legacy=await SqliteStorage.open({userData:root,intent:'open',role:'test',expectedDatabaseId:id,registryModule:registry()});t.after(()=>legacy.close());
 assert.deepEqual(await legacy.execute('fixture.legacyProofSnapshot',{}),before);
});

test('更新已核对来源元数据默认保留待确认状态，解除必须显式指定ok',async t=>{
 const {root,storage}=await fixture(t);await storage.execute('fixture.seedProofs',{});const id=storage.status.databaseId;await storage.close();
 const next=await SqliteStorage.open({userData:root,intent:'open',role:'test',expectedDatabaseId:id,registryModule:registry('upgrade')});t.after(()=>next.close());
 const held=await next.execute('fixture.refreshProof',{});assert.equal(held.state,'needs_confirmation');assert.equal(held.checked_at,123n);
 const confirmed=await next.execute('fixture.refreshProof',{confirm:true});assert.equal(confirmed.state,'ok');assert.equal(confirmed.reason,null);
});
