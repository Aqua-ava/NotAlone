import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  assert.deepEqual(actions.slice(-2), ['vault-close','window-close']);
  await assert.rejects(controller.open(id));
});
test('退出与打开并发时等待打开收尾后释放正文持有者', async () => {
  const gate=deferred(), actions=[];
  const controller=new QuarantineController({list:async()=>[],open:async()=>{await gate.promise;return {close:()=>actions.push('vault-close')};}},
    async()=>({closed:new Promise(()=>{}),focus(){},close:async()=>{actions.push('window-close');}}));
  const opening=controller.open(id); await Promise.resolve();
  const closing=controller.close(); gate.resolve(); await Promise.all([opening,closing]);
  assert.deepEqual(actions,['vault-close','window-close']);
});
test('展示失败时仍释放仓句柄，后续可重试', async () => {
  let closed=0;
  const controller=new QuarantineController({list:async()=>[],open:async()=>({close:()=>closed++})}, async()=>{throw new Error('synthetic');});
  await assert.rejects(controller.open(id)); assert.equal(closed,1);
  await controller.close();
});
test('隔离窗口关闭失败后保留原资源，重试真正清理完成前不确认退出', async t => {
  const root = await mkdtemp(join(tmpdir(), 'notalone-quarantine-close-retry-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  const vault = await QuarantineVault.create(join(root,id), {scopeDigest:'f'.repeat(64),displayName:'合成退出重试'});
  t.after(() => vault.close());
  const gate = deferred();
  let calls = 0, settled = false;
  const controller = new QuarantineController({list:async()=>[],open:async()=>vault}, async()=>({
    closed:new Promise(()=>{}),focus(){},async close(){
      assert.throws(() => vault.summary(), {code:'quarantine_vault_closed'}, '等待窗口清理前先撤下正文访问');
      if(++calls===1)throw new Error('合成窗口清理失败');await gate.promise;
    },
  }));
  await controller.open(id);
  await assert.rejects(controller.close(), /合成窗口清理失败/);
  assert.throws(() => vault.summary(), {code:'quarantine_vault_closed'});
  const retry = controller.close().then(() => {settled=true;});
  await new Promise(setImmediate);
  assert.equal(calls, 2, '重试仍须清理首次失败的同一窗口');
  assert.equal(settled, false, '尚未完成清理不得确认退出');
  gate.resolve();await retry;
  await controller.close();assert.equal(calls, 2, '成功后不再重复清理');
});
test('隔离窗口会话清理首次失败后重试原会话，并发关闭不重复清理', async t => {
  const result = await build({
    stdin:{contents:"export {presentQuarantine} from './src/main/quarantine/window';export {boundary} from 'electron';",resolveDir:process.cwd()},
    bundle:true,platform:'node',format:'esm',write:false,
    plugins:[{name:'electron-session-boundary',setup(builder){
      builder.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'synthetic-electron'}));
      builder.onLoad({filter:/.*/,namespace:'synthetic-electron'},()=>({contents:`
        import {EventEmitter} from 'node:events';
        export const boundary={clears:0,destroys:0};
        export const session={fromPartition:()=>({setPermissionCheckHandler(){},setPermissionRequestHandler(){},
          webRequest:{onBeforeRequest(){}},async clearStorageData(){if(++boundary.clears===1)throw new Error('synthetic_session_clear_failed');}})};
        export class BrowserWindow extends EventEmitter {
          destroyed=false;webContents={setWindowOpenHandler(){},on(){}};
          async loadURL(){} show(){} focus(){} isMinimized(){return false;} isDestroyed(){return this.destroyed;}
          destroy(){this.destroyed=true;boundary.destroys++;this.emit('closed');}
        }
      `}));
    }}],
  });
  await writeFile(join(dir,'window.mjs'),result.outputFiles[0].text);
  const {presentQuarantine,boundary} = await import(pathToFileURL(join(dir,'window.mjs')));
  const root=await mkdtemp(join(tmpdir(),'notalone-quarantine-session-close-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const vault=await QuarantineVault.create(join(root,id),{scopeDigest:'a'.repeat(64),displayName:'合成会话清理'});
  t.after(()=>vault.close());
  const presentation=await presentQuarantine(vault);
  await assert.rejects(presentation.close(),/synthetic_session_clear_failed/);
  await presentation.closed;
  const first=presentation.close(),second=presentation.close();
  assert.equal(first,second,'并发关闭共用本轮清理');
  await Promise.all([first,second]);
  assert.deepEqual(boundary,{clears:2,destroys:1});
  await presentation.close();assert.equal(boundary.clears,2);
});
test('切换隔离仓关闭失败后再次打开原仓，先清理失效窗口再重新打开', async () => {
  const opened=[];
  let closes=0,focuses=0;
  const controller=new QuarantineController({list:async()=>[],open:async key=>{opened.push(key);return {close(){}};}},async()=>({
    closed:new Promise(()=>{}),focus(){focuses++;},async close(){if(++closes===1)throw new Error('synthetic_close_failed');},
  }));
  await controller.open(id);
  await assert.rejects(controller.open('snapshot-other'),/synthetic_close_failed/);
  await controller.open(id);
  assert.equal(focuses,0,'不聚焦正文已经失效的旧窗口');
  assert.equal(closes,2);assert.deepEqual(opened,[id,id]);
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
