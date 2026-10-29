import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile, readFile, rename, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite/client.ts';
import { DeletionService } from '../src/storage/sqlite/deletion/service.ts';
import { ActiveHolders } from '../src/storage/sqlite/deletion/holders.ts';
import { ManagedFiles } from '../src/storage/sqlite/deletion/managed-files.ts';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { SqliteDeletionHttp } from '../src/storage/sqlite/deletion/http.ts';

async function fixture(t) {
  const userData = await realpath(await mkdtemp(join(tmpdir(), 'notalone-delete-05-')));
  const options = { userData, intent: 'create', role: 'test', registryModule: new URL('./fixtures/sqlite/deletion-registry.mjs', import.meta.url).href };
  let storage = await SqliteStorage.open(options);
  const holders = new ActiveHolders();
  const files = new ManagedFiles(userData);
  const service = () => new DeletionService(storage, holders, files, { drainTimeoutMs: 100 });
  t.after(async () => { await storage.close(); await rm(userData, { recursive: true, force: true }); });
  return { userData, files, holders, get storage() { return storage; }, service,
    async reopen() { const id = storage.status.databaseId; await storage.close(); storage = await SqliteStorage.open({ ...options, intent: 'open', expectedDatabaseId: id }); } };
}
const request = (key = 'delete-1', scope = { kind: 'source', contactId: 'a', sourceId: 'r1' }) => ({ ownerId: 'o', requestKey: key, scope });

test('来源删除立即封禁旧写入，按同一操作清理且幂等键不会改目标', async t => {
  const f = await fixture(t); await f.storage.execute('sample.seed', {});
  const first = await f.service().plan(request());
  assert.equal(first.state, 'fenced');
  assert.equal(await f.storage.execute('sample.write', { generation: 0n, key: 'late' }), 'stale');
  assert.equal((await f.service().plan(request())).operationId, first.operationId);
  await assert.rejects(f.service().plan(request('delete-1', { kind: 'source', contactId: 'b', sourceId: 'r2' })), { code: 'deletion_request_conflict' });
  const done = await f.service().advance({ ownerId: 'o', operationId: first.operationId });
  assert.equal(done.state, 'completed');
  assert.deepEqual(await f.storage.execute('sample.read', {}), { bodies: [], ledger: 1n, generation: 1n });
  assert.equal((await f.service().advance({ ownerId: 'o', operationId: first.operationId })).state, 'completed');
  assert.equal(await f.storage.execute('deletion.requestAllowed', { ownerId: 'o', namespace: 'sample.process', key: 'old-request' }), false);
  await assert.rejects(f.service().status({ ownerId: 'other', operationId: first.operationId }), { code: 'deletion_not_found' });
});

async function fileTarget(f, name = 'copy.txt', id = 'file-1') {
  f.files.prepareArea('runtime');
  const location = join(f.userData, 'managed/runtime-copies', name);
  await writeFile(location, '合成受管正文', {mode: 0o600});
  const target = {kind: 'file', domain: 'sample', ownerId: 'o', fileId: id, generation: '1', address: f.files.capture('runtime', name), holderKeys: ['sample:copy']};
  await f.storage.execute('sample.file', target);
  return {target, location};
}
test('持有者关闭末次写入结束前不删除文件，超时保持未完成并沿原操作重试', async t => {
  const f = await fixture(t); await f.storage.execute('sample.seed', {});
  const {location} = await fileTarget(f);
  let release; const closed = new Promise(resolve => {release = resolve;});
  f.holders.register({key: 'sample:copy', generation: 0n, ownerId: 'o', contactId: 'b', async close() { await closed; await writeFile(location, '合成末次写入', {mode: 0o600}); }});
  const op = await f.service().plan(request());
  const blocked = await f.service().advance(op);
  assert.equal(blocked.state, 'blocked');
  assert.equal(await readFile(location, 'utf8'), '合成受管正文');
  assert.equal((await f.storage.execute('sample.read', {})).bodies.length, 2);
  assert.throws(() => f.holders.register({key: 'sample:copy', generation: 0n, ownerId: 'o', close: async () => {}}), {code: 'deletion_holder_fenced'});
  release(); await closed;
  const done = await f.service().advance(op);
  assert.equal(done.state, 'completed');
  await assert.rejects(readFile(location), {code: 'ENOENT'});
});
test('文件身份错误不误删替换件，部分进度及墓碑跨重开保留', async t => {
  const f = await fixture(t); await f.storage.execute('sample.seed', {});
  const {location} = await fileTarget(f);
  const op = await f.service().plan(request());
  await rename(location, location + '.held'); await writeFile(location, '替换件必须保留', {mode: 0o600});
  const blocked = await f.service().advance(op);
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.targets.filter(t => t.state === 'cleared').length, 2);
  assert.equal(await readFile(location, 'utf8'), '替换件必须保留');
  await f.reopen();
  assert.equal((await f.service().status(op)).operationId, op.operationId);
  assert.equal(await f.storage.execute('deletion.requestAllowed', {ownerId: 'o', namespace: 'sample.process', key: 'old-request'}), false);
  await rm(location); await rename(location + '.held', location);
  const done = await f.service().advance(op);
  assert.equal(done.state, 'completed'); assert.ok(done.targets.every(t => t.target === null));
});
test('错误owner目标在计划阶段拒绝并回滚资格代次', async t => {
  const f = await fixture(t); await f.storage.execute('sample.seed', {});
  const {target, location} = await fileTarget(f);
  await f.storage.execute('sample.replaceFileTarget', {...target, ownerId: 'other'});
  await assert.rejects(f.service().plan(request()), {code: 'deletion_target_invalid'});
  assert.equal((await f.storage.execute('sample.read', {})).generation, 0n);
  assert.equal(await readFile(location, 'utf8'), '合成受管正文');
});
test('清理中发现新闭包必须推进计划修订，旧复核不能完成新计划', async t => {
  const f = await fixture(t); await f.storage.execute('sample.seed', {});
  const op = await f.service().plan(request());
  await f.storage.execute('sample.spawnOnClear', {});
  const extended = await f.service().advance(op);
  assert.equal(extended.state, 'fenced'); assert.equal(extended.planRevision, op.planRevision + 1n);
  assert.equal(extended.checks.length, 0);
  assert.equal((await f.service().advance(op)).state, 'completed');
});
test('联系人和账户删除清理对应最小台账，其他owner和墓碑不受影响', async t => {
  for (const kind of ['contact', 'account']) {
    const f = await fixture(t); await f.storage.execute('sample.seed', {});
    const op = await f.service().plan(request('all', kind === 'account' ? {kind} : {kind, contactId: 'a'}));
    assert.equal((await f.service().advance(op)).state, 'completed');
    assert.equal((await f.storage.execute('sample.read', {})).ledger, 0n);
    assert.equal(await f.storage.execute('deletion.requestAllowed', {ownerId: 'o', namespace: 'sample.process', key: 'old-request'}), false);
    assert.equal(await f.storage.execute('deletion.requestAllowed', {ownerId: 'other', namespace: 'sample.process', key: 'old-request'}), true);
    let closed = false;
    const release = f.holders.register({key: 'sample:copy', generation: 0n, ownerId: 'other', close: async () => {closed = true;}});
    assert.equal(closed, false); await release(); assert.equal(closed, true);
  }
});
test('SQLite长读者阻止checkpoint时保持未完成，释放后复核页与WAL/SHM', async t => {
  const f = await fixture(t); await f.storage.execute('sample.seed', {}); await f.storage.execute('sample.large', {});
  const reader = new DatabaseSync(join(f.userData, 'managed/sqlite/notalone.sqlite'));
  reader.exec('BEGIN'); reader.prepare('SELECT body FROM sample_body').all();
  const op = await f.service().plan(request());
  try {
    const blocked = await f.service().advance(op);
    assert.equal(blocked.state, 'blocked');
    assert.equal(blocked.checks.find(c => c.kind === 'final_recheck').result.proof, 'deletion_checkpoint_busy');
  } finally { reader.exec('ROLLBACK'); reader.close(); }
  assert.equal((await f.service().advance(op)).state, 'completed');
  const {storageState} = await f.storage.execute('deletion.compact', {});
  assert.equal(storageState.freePages, 0n); assert.equal(storageState.walBytes, 0n);
  assert.equal(storageState.journalBytes, 0n); assert.equal(storageState.tempStore, 2n);
  assert.equal(storageState.secureDelete, 1n); assert.equal(storageState.unexpectedFiles, 0);
  assert.equal(typeof storageState.shmBytes, 'bigint');
});
test('持有者释放失败不能伪报完成，未知目录/链接/外部原件保持原样', async t => {
  const f = await fixture(t); await f.storage.execute('sample.seed', {});
  f.holders.register({key: 'sample:copy', generation: 0n, ownerId: 'o', async close() {throw new Error('合成释放失败');}});
  const op = await f.service().plan(request());
  assert.equal((await f.service().advance(op)).state, 'blocked');
  assert.equal((await f.storage.execute('sample.read', {})).bodies.length, 2);
  const external = join(f.userData, 'original.txt'); await writeFile(external, '用户合成原件', {mode: 0o600});
  f.files.prepareArea('media'); await symlink(external, join(f.userData, 'managed/media/link'));
  for (const locator of ['../../original.txt', '/original.txt', 'link']) assert.throws(() => f.files.capture('media', locator), {code: 'deletion_file_ownership'});
  assert.throws(() => f.files.capture('skills', 'anything'), {code: 'deletion_file_ownership'});
  assert.equal(await readFile(external, 'utf8'), '用户合成原件');
});
test('显式缺少删除注册时统一拒绝，不把身份空闭包判成功', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'notalone-delete-unwired-')));
  const storage = await SqliteStorage.open({userData: root, intent: 'create', role: 'test', registryModule: new URL('./fixtures/sqlite/deletion-unregistered-registry.mjs', import.meta.url).href});
  try {
    for(const scope of [{kind:'account'},{kind:'contact',contactId:'a'},{kind:'source',contactId:'a',sourceId:'r1'},{kind:'contact_history',contactId:'a'},
      {kind:'discussion',contactId:'a',discussionId:'discussion'},
      {kind:'media_result_clear',contactId:'a',messageId:'m'},{kind:'media_result_replace',contactId:'a',messageId:'m'}]) {
      await assert.rejects(storage.execute('deletion.plan', request('unwired',scope)), {code: 'deletion_domain_unavailable'});
    }
    assert.deepEqual(await storage.execute('deletion.list',{ownerId:'o'}),[]);
  }
  finally {await storage.close(); await rm(root, {recursive: true, force: true});}
});
test('文件清理前复验领域代次与保留资格，不只凭旧路径和inode删除', async t => {
  const f = await fixture(t); await f.storage.execute('sample.seed', {});
  const {location} = await fileTarget(f);
  const op = await f.service().plan(request());
  await f.storage.execute('sample.retainFile', {});
  assert.equal((await f.service().advance(op)).state, 'blocked');
  assert.equal(await readFile(location, 'utf8'), '合成受管正文');
});
test('原来源删除HTTP和公开进度访问真实SQLite服务，认证前拒绝且状态不泄露受管定位', async t => {
  const f = await fixture(t); await f.storage.execute('sample.seed', {});
  const {location} = await fileTarget(f);
  const adapter = new SqliteDeletionHttp(f.service(), 'o');
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer synthetic-test') {res.writeHead(401); res.end(); return;}
    if (!await adapter.handle(req, res)) {res.writeHead(404); res.end();}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const send = (path, method = 'GET', body) => fetch(endpoint + path, {method, headers: {authorization: 'Bearer synthetic-test', 'content-type': 'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  assert.equal((await fetch(endpoint + '/api/contacts/a/sources/r1', {method: 'DELETE'})).status, 401);
  assert.equal((await f.storage.execute('sample.read', {})).generation, 0n);
  assert.equal((await send('/api/contacts/a/sources/r1', 'DELETE', {ownerId: 'other'})).status, 400);
  const receipt = await send('/api/contacts/a/sources/r1', 'DELETE');
  assert.equal(receipt.status, 202); const value = await receipt.json();
  assert.equal(value.status, 'succeeded');
  const progress = await (await send(`/api/tasks/status?contact_id=a&task_id=${value.task_id}`)).json();
  assert.equal(progress.task_type, 'delete'); assert.equal(progress.status, 'succeeded'); assert.ok(progress.steps.every(s => s.status === 'succeeded'));
  const state = await send(`/api/deletions/${value.operation_id}`); const text = await state.text();
  assert.equal(JSON.parse(text).state, 'completed'); assert.equal(text.includes('copy.txt'), false); assert.equal(text.includes('managed/'), false);
  assert.equal(text.includes('managed_locator'), false); assert.equal(text.includes('expected_identity'), false);
  assert.equal((await (await send('/api/contacts/a/sources/r1', 'DELETE')).json()).task_id, value.task_id);
  assert.equal((await send(`/api/deletions/${value.operation_id}/retry`, 'POST', {})).status, 400);
  assert.equal((await send(`/api/deletions/${value.operation_id}/retry`, 'POST', {confirmed: true})).status, 200);
  assert.equal((await send(`/api/tasks/status?contact_id=b&task_id=${value.task_id}`)).status, 404);
  assert.equal((await (await send('/api/deletions')).json()).operations.length, 1);
  await assert.rejects(readFile(location), {code: 'ENOENT'});
});
test('已登记目录按空目录及子项顺序清理，跨重开旧runner拒绝确认', async t => {
  const f = await fixture(t); await f.storage.execute('sample.seed', {}); f.files.prepareArea('runtime');
  await mkdir(join(f.userData, 'managed/runtime-copies/copy'), {mode: 0o700});
  await writeFile(join(f.userData, 'managed/runtime-copies/copy/events.jsonl'), '合成日志', {mode: 0o600});
  for (const [fileId, locator, kind] of [['dir', 'copy', 'directory'], ['child', 'copy/events.jsonl', 'file']]) await f.storage.execute('sample.file', {kind: 'file', domain: 'sample', ownerId: 'o', fileId, generation: '1', address: f.files.capture('runtime', locator, kind), holderKeys: []});
  const op = await f.service().plan(request());
  const old = await f.storage.execute('deletion.claim', op);
  await f.reopen();
  await assert.rejects(f.storage.execute('deletion.verify', {...op, token: old.token}), {code: 'deletion_stale_runner'});
  assert.equal((await f.service().advance(op)).state, 'completed');
});
test('未知SQLite临时文件使复核失败且保留现场，清除后同操作重试', async t => {
  const f = await fixture(t); await f.storage.execute('sample.seed', {});
  const unknown = join(f.userData, 'managed/sqlite/unknown.tmp'); await writeFile(unknown, '合成未知对象', {mode: 0o600});
  const op = await f.service().plan(request());
  assert.equal((await f.service().advance(op)).state, 'blocked'); assert.equal(await readFile(unknown, 'utf8'), '合成未知对象');
  await rm(unknown); assert.equal((await f.service().advance(op)).state, 'completed');
});
test('清空旧资料的持有者门禁允许新合法代次的新副本', () => {
  const holders = new ActiveHolders();
  const op = {ownerId: 'o', scope: {kind: 'contact_history', contactId: 'a'}, acceptedGeneration: 2n};
  holders.fence(op, []);
  assert.throws(() => holders.register({key: 'sample:old', ownerId: 'o', contactId: 'a', generation: 1n, close: async () => {}}), {code: 'deletion_holder_fenced'});
  assert.doesNotThrow(() => holders.register({key: 'sample:new', ownerId: 'o', contactId: 'a', generation: 2n, close: async () => {}}));
});
test('明确失败的持有者close可在同操作重试，未完成的close不重新并发执行', async t => {
  const f = await fixture(t); await f.storage.execute('sample.seed', {});
  let attempts = 0;
  f.holders.register({key: 'sample:copy', ownerId: 'o', generation: 0n, async close() {if (++attempts === 1) throw new Error('合成暂时失败');}});
  const op = await f.service().plan(request());
  assert.equal((await f.service().advance(op)).state, 'blocked');
  assert.equal((await f.service().advance(op)).state, 'completed');
  assert.equal(attempts, 2);
});
test('账户新独立删除必须有新请求键，普通任务状态交给原处理器', async t => {
  const f = await fixture(t); await f.storage.execute('sample.seed', {});
  const adapter = new SqliteDeletionHttp(f.service(), 'o');
  const server = createServer(async (req, res) => {if (!await adapter.handle(req, res)) {res.writeHead(418); res.end('ordinary_task_handler');}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const erase = key => fetch(endpoint + '/api/account', {method: 'DELETE', headers: {'content-type': 'application/json', ...(key ? {'idempotency-key': key} : {})}, body: JSON.stringify({confirmed: true, confirm_scope: 'account'})});
  assert.equal((await erase()).status, 400);
  const first = await (await erase('account-one')).json();
  await f.storage.execute('sample.refill', {});
  assert.equal((await (await erase('account-one')).json()).operation_id, first.operation_id);
  assert.equal((await f.storage.execute('sample.read', {})).bodies.length, 1);
  const second = await (await erase('account-two')).json();
  assert.notEqual(second.operation_id, first.operation_id);
  assert.equal((await f.storage.execute('sample.read', {})).bodies.length, 0);
  const ordinary = await fetch(endpoint + '/api/tasks/status?contact_id=a&task_id=ordinary-import');
  assert.equal(ordinary.status, 418); assert.equal(await ordinary.text(), 'ordinary_task_handler');
});
test('领域回调意外返回Promise时回滚目标进度，不能提前确认已清理', async t => {
  const f = await fixture(t); await f.storage.execute('sample.seed', {});
  const op = await f.service().plan(request()); await f.storage.execute('sample.asyncClear', {});
  const result = await f.service().advance(op);
  assert.equal(result.state, 'blocked');
  assert.ok(result.targets.every(t => t.state !== 'cleared'));
  assert.equal(result.checks.find(c => c.kind === 'final_recheck').result.proof, 'async_transaction_forbidden');
  assert.equal((await f.storage.execute('sample.read', {})).bodies.length, 2);
});
test('账号删除排空全部owner持有者，不拿联系人代次和账号epoch比较而漏放', async t => {
  const f=await fixture(t);await f.storage.execute('sample.seed',{});let closed=false;
  f.holders.register({key:'sample:high_generation',ownerId:'o',contactId:'b',generation:999n,close:async()=>{closed=true;}});
  const op=await f.service().plan(request('account-fence',{kind:'account'}));
  assert.equal((await f.service().advance(op)).state,'completed');assert.equal(closed,true);
});

test('关闭末写新文件和新持有者在同一runner重新收集至稳定闭包后首轮完成',async t=>{
 const f=await fixture(t);await f.storage.execute('sample.seed',{});
 f.files.prepareArea('runtime');
 const add=async(name,key)=>{
  const location=join(f.userData,'managed/runtime-copies',name);
  await writeFile(location,'合成关闭末写',{mode:0o600});
  await f.storage.execute('sample.file',{kind:'file',domain:'sample',ownerId:'o',fileId:name,generation:'1',address:f.files.capture('runtime',name),holderKeys:[key]});
  return location;
 };
 let secondClosed=false;
 f.holders.register({key:'sample:copy',ownerId:'o',generation:0n,async close(){
  await add('late-a','sample:second');
  f.holders.register({key:'sample:second',ownerId:'o',generation:0n,async close(){secondClosed=true;await add('late-b','sample:third');}});
 }});
 const op=await f.service().plan(request('close-new-files'));
 const result=await f.service().advance(op);
 assert.equal(result.operationId,op.operationId);assert.equal(result.state,'completed');
 assert.ok(result.planRevision>op.planRevision);assert.equal(secondClosed,true);
 for(const name of ['late-a','late-b'])await assert.rejects(readFile(join(f.userData,'managed/runtime-copies',name)),{code:'ENOENT'});
});
