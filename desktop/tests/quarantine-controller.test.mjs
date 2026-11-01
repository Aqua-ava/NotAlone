import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { QuarantineLibrary } from '../../backend-ts/src/history/quarantine-library.ts';
import { QuarantineVault } from '../../backend-ts/src/history/quarantine-vault.ts';

const dir = await mkdtemp(join(tmpdir(), 'notalone-quarantine-controller-'));
await build({entryPoints: ['src/main/quarantine/controller.ts', 'src/main/quarantine/bridge.ts', 'src/main/quarantine/paths.ts'],
  outdir: dir, bundle: true, format: 'esm', platform: 'node'});
const {QuarantineController} = await import(pathToFileURL(join(dir, 'controller.js')));
const {installQuarantineBridge} = await import(pathToFileURL(join(dir, 'bridge.js')));
const {resolveQuarantineRoot} = await import(pathToFileURL(join(dir, 'paths.js')));
test.after(() => rm(dir, {recursive: true, force: true}));
const id = 'snapshot-20261030-00000000-0000-4000-8000-000000000001';
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; }
function fixture(overrides = {}) {
  const actions = [];
  const closed = deferred();
  const vault = {close: () => actions.push('vault-close')};
  const library = {list: async () => [{id, status: {displayName:'合成联系人', recordCount:2, createdAt:1, snapshotComplete:true, snapshotState:'complete', text:'private', path:'/private'}}],
    open: async key => {actions.push(['open', key]); return vault;}, ...overrides};
  const present = async () => ({closed:closed.promise, focus:() => actions.push('focus'),
    close:async () => { actions.push('window-close'); closed.resolve(); }});
  return {controller:new QuarantineController(library,present), actions, closed, vault};
}
test('显式资料目录只能列出和打开自身隔离仓，默认实例仍保留原仓', async t => {
  const base = await mkdtemp(join(tmpdir(), 'notalone-quarantine-scope-'));
  t.after(() => rm(base, {recursive:true,force:true}));
  const appData = join(base, 'application-data'), userData = join(base, 'isolated-user-data');
  const defaultRoot = join(appData, 'NotAlone-Quarantine');
  await mkdir(defaultRoot, {recursive:true,mode:0o700});
  await mkdir(userData, {mode:0o700});
  const vault = await QuarantineVault.create(join(defaultRoot, id), {scopeDigest:'d'.repeat(64),displayName:'合成默认实例'});
  vault.begin({expectedPartitions:['synthetic-partition']});
  vault.appendPage([{kind:'text',text:'默认实例的合成隔离文字',status:'4',originalType:'1',sender:'unknown',sentAt:null,
    partition:'synthetic-partition',table:'synthetic-table',localId:'1',serverId:null}]);
  vault.complete({scopeDigest:'d'.repeat(64),sourceContinuity:'held',snapshotComplete:true,completedPartitions:['synthetic-partition']});
  vault.close();

  assert.equal(resolveQuarantineRoot(appData,join(appData,'NotAloneDesktop'),''),defaultRoot);
  assert.equal(resolveQuarantineRoot(appData,join(appData,'NotAloneDesktop'),'relative-data'),defaultRoot);
  const isolatedRoot = resolveQuarantineRoot(appData,userData,userData);
  const isolated = new QuarantineLibrary(isolatedRoot);
  assert.deepEqual(await isolated.list(), []);
  await assert.rejects(isolated.open(id), {code:'quarantine_root_invalid'});
  const original = new QuarantineLibrary(defaultRoot);
  assert.deepEqual((await original.list()).map(item=>item.id), [id]);
  await mkdir(isolatedRoot, {mode:0o700});
  const isolatedVault = await QuarantineVault.create(join(isolatedRoot,id), {scopeDigest:'e'.repeat(64),displayName:'合成隔离实例'});
  isolatedVault.begin({expectedPartitions:['synthetic-partition']});
  isolatedVault.complete({scopeDigest:'e'.repeat(64),sourceContinuity:'held',snapshotComplete:true,completedPartitions:['synthetic-partition']});
  isolatedVault.close();
  assert.deepEqual((await isolated.list()).map(item=>item.status.displayName), ['合成隔离实例']);
  const ownVault = await isolated.open(id);
  assert.equal(ownVault.summary().recordCount,0);
  ownVault.close();
  const originalVault = await original.open(id);
  assert.equal(originalVault.summary().recordCount,1);
  originalVault.close();
});
test('目录只投影摘要，不向业务页面带正文或路径', async () => {
  const {controller} = fixture();
  assert.deepEqual(await controller.list(), [{id,displayName:'合成联系人',recordCount:2,createdAt:1,snapshotComplete:true,snapshotState:'complete'}]);
  await controller.close();
});
test('重复打开只聚焦，关闭窗口后释放隔离仓', async () => {
  const {controller,actions,closed} = fixture();
  await controller.open(id); await controller.open(id);
  assert.deepEqual(actions, [['open',id],'focus']);
  closed.resolve(); await controller.close();
  assert.deepEqual(actions.slice(-2), ['window-close','vault-close']);
  await assert.rejects(controller.open(id));
});
test('退出与打开并发时等待打开收尾后释放正文持有者', async () => {
  const gate=deferred(), actions=[];
  const controller=new QuarantineController({list:async()=>[],open:async()=>{await gate.promise;return {close:()=>actions.push('vault-close')};}},
    async()=>({closed:new Promise(()=>{}),focus(){},close:async()=>{actions.push('window-close');}}));
  const opening=controller.open(id); await Promise.resolve();
  const closing=controller.close(); gate.resolve(); await Promise.all([opening,closing]);
  assert.deepEqual(actions,['window-close','vault-close']);
});
test('展示失败时仍释放仓句柄，后续可重试', async () => {
  let closed=0;
  const controller=new QuarantineController({list:async()=>[],open:async()=>({close:()=>closed++})}, async()=>{throw new Error('synthetic');});
  await assert.rejects(controller.open(id)); assert.equal(closed,1);
  await controller.close();
});
test('隔离桥仅允许管理页面和安全快照标识，错误不泄露本机路径', async () => {
  const handlers=new Map(),roles=[];
  installQuarantineBridge({handle:(channel,handler,role)=>{handlers.set(channel,handler);roles.push(role);}},
    {list:async()=>{throw new Error('/private/source');},open:async()=>{throw new Error('/private/source');}});
  assert.deepEqual(roles,['manager','manager']);
  for(const args of [[],['../source'],['/private/source'],[id,'extra']]) assert.throws(()=>handlers.get('quarantine:open')(...args));
  assert.throws(()=>handlers.get('quarantine:list')('extra'));
  await assert.rejects(handlers.get('quarantine:list')(), /未能读取本机隔离历史/);
  await assert.rejects(handlers.get('quarantine:open')(id), /未能打开本机隔离历史/);
});
