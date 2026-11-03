import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {clearStartupDiagnostic, finishStartupDiagnostic, readStartupDiagnostic, startupErrorCode, startupFailureCause, writeStartupDiagnostic} from '../src/startup-diagnostics.ts';

async function fixture(t) {
  const root=await mkdtemp(path.join(tmpdir(),'notalone-safe-startup-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  return path.join(root,'backend.info');
}

test('启动诊断只持久化白名单原因，不读取异常getter或保存原始原因',async t=>{
  const info=await fixture(t),secret='synthetic-private-credential-and-chat';
  const error=new Error(secret,{cause:new Error(secret)});
  Object.defineProperty(error,'code',{get(){throw new Error('不应读取 getter');}});
  assert.equal(startupFailureCause(error),'unexpected_failure');
  await writeStartupDiagnostic(info,'configuration');
  await finishStartupDiagnostic(info,startupFailureCause(error));
  const file=info+'.startup-diagnostic.json',raw=await readFile(file,'utf8');
  assert.ok(!raw.includes(secret));assert.ok(Buffer.byteLength(raw)<=512);
  assert.equal((await stat(file)).mode&0o777,0o600);
  assert.equal(await startupErrorCode(info,'process_exit'),'backend_startup_configuration_failed');
  assert.equal((await readStartupDiagnostic(info)).cause,'unexpected_failure');
  await writeStartupDiagnostic(info,'storage');
  await finishStartupDiagnostic(info,'timeout');
  await finishStartupDiagnostic(info,'process_exit');
  assert.equal((await readStartupDiagnostic(info)).cause,'timeout');
  await clearStartupDiagnostic(info);
  assert.equal(await startupErrorCode(info,'process_exit'),undefined);
});

test('损坏、额外字段、超限、宽权限与符号链接诊断不进入公开错误',async t=>{
  const info=await fixture(t),file=info+'.startup-diagnostic.json';
  const valid={version:1,stage:'storage',cause:'storage_mismatch',recordedAt:1};
  for(const value of ['{',JSON.stringify({...valid,secret:'synthetic'}),JSON.stringify({...valid,stage:'private-path'}),' '.repeat(513)]){
    await writeFile(file,value,{mode:0o600});
    assert.equal(await startupErrorCode(info,'process_exit'),undefined);
  }
  await rm(file);await writeFile(file,JSON.stringify(valid),{mode:0o644});
  assert.equal(await readStartupDiagnostic(info),undefined);
  await rm(file);const target=path.join(path.dirname(info),'synthetic-private');
  await writeFile(target,JSON.stringify(valid),{mode:0o600});await symlink(target,file);
  assert.equal(await readStartupDiagnostic(info),undefined);
  await writeStartupDiagnostic(info,'runtime');
  assert.equal(await readFile(target,'utf8'),JSON.stringify(valid));
  assert.equal((await readStartupDiagnostic(info)).stage,'runtime');
});

test('诊断路径不可写不会阻止启动异常收尾',async t=>{
  const info=path.join(await fixture(t),'missing','backend.info');
  await writeStartupDiagnostic(info,'runtime');
  assert.equal(await finishStartupDiagnostic(info,'process_exit'),undefined);
  await clearStartupDiagnostic(info);
});
