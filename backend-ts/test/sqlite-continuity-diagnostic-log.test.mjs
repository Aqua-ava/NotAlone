import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ContinuityDiagnosticLog } from '../src/storage/sqlite/continuity-diagnostic-log.ts';

const filename = 'history-continuity.jsonl';
const event = (contactPrefix = 'abcd1234') => ({ entry: 'history.readPreflight', contactPrefix, branch: 'G01' });
function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'notalone-continuity-log-')));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const files = root => Array.from({ length: 4 }, (_, i) => path.join(root, 'logs', filename + (i ? `.${i}` : '')));
const records = root => files(root).filter(existsSync).flatMap(file => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
const unavailable = work => assert.throws(work, error => error?.name === 'StorageFailure' && error.code === 'history_continuity_diagnostic_unavailable' && error.message === error.code);

test('构造、启动清理和无日志删除不创建目录', t => {
  const root = fixture(t), log = new ContinuityDiagnosticLog(root);
  assert.equal(existsSync(path.join(root, 'logs')), false);
  log.prune();
  log.erase('abcd1234');
  log.erase();
  assert.equal(existsSync(path.join(root, 'logs')), false);
});

test('围栏日志只保存白名单字段、ISO时间及私有权限，并跨实例追加', t => {
  const root = fixture(t), first = new ContinuityDiagnosticLog(root);
  first.append({ ...event(), errorCode: 'history_source_unverified' });
  assert.equal(existsSync(files(root)[0]), true);
  new ContinuityDiagnosticLog(root).append(event('deadbeef'));
  const saved = records(root);
  assert.equal(saved.length, 2);
  assert.deepEqual(saved.map(row => row.contactPrefix), ['abcd1234', 'deadbeef']);
  assert.deepEqual(Object.keys(saved[0]).sort(), ['branch', 'contactPrefix', 'entry', 'errorCode', 'time']);
  assert.equal(new Date(saved[0].time).toISOString(), saved[0].time);
  assert.equal(lstatSync(path.join(root, 'logs')).mode & 0o777, 0o700);
  assert.equal(lstatSync(files(root)[0]).mode & 0o777, 0o600);
});

test('围栏日志按字节轮转，只保留当前文件和三个归档', t => {
  const root = fixture(t), log = new ContinuityDiagnosticLog(root, { maxBytes: 512 });
  for (let i = 0; i < 40; i++) log.append(event(i.toString(16).padStart(8, '0')));
  assert.equal(files(root).every(existsSync), true);
  for (const file of files(root)) {
    assert.ok(lstatSync(file).size <= 512);
    assert.equal(lstatSync(file).mode & 0o777, 0o600);
  }
  const saved = records(root);
  assert.ok(saved.length < 40);
  assert.equal(records(root).find(row => row.contactPrefix === '00000027')?.branch, 'G01');
  assert.equal(existsSync(path.join(root, 'logs', filename + '.4')), false);
});

test('启动和追加均清理超过七天的记录，旧归档按留存期限删除', t => {
  const root = fixture(t), log = new ContinuityDiagnosticLog(root);
  log.append(event());
  const current = files(root)[0], old = new Date(Date.now() - 8 * 86400_000);
  const saved = JSON.parse(readFileSync(current, 'utf8'));
  writeFileSync(current, JSON.stringify({ ...saved, time: old.toISOString() }) + '\n');
  new ContinuityDiagnosticLog(root).prune();
  assert.deepEqual(records(root), []);
  log.append(event());
  const fresh = JSON.parse(readFileSync(current, 'utf8'));
  writeFileSync(current, JSON.stringify({ ...fresh, time: old.toISOString() }) + '\n');
  log.append(event('deadbeef'));
  assert.deepEqual(records(root).map(row => row.contactPrefix), ['deadbeef']);
  writeFileSync(files(root)[1], JSON.stringify(fresh) + '\n', { mode: 0o600 });
  utimesSync(files(root)[1], old, old);
  log.prune();
  assert.equal(existsSync(files(root)[1]), false);
});

test('按联系人删除过滤全部归档，账户删除清除全部日志', t => {
  const root = fixture(t), log = new ContinuityDiagnosticLog(root, { maxBytes: 512 });
  for (let i = 0; i < 30; i++) log.append(event(i % 2 ? 'abcd1234' : 'deadbeef'));
  log.erase('abcd1234');
  const saved = records(root);
  assert.ok(saved.length > 0);
  assert.ok(saved.every(row => row.contactPrefix === 'deadbeef'));
  log.erase();
  assert.equal(files(root).some(existsSync), false);
});

test('敏感字段、非法前缀、未知入口分支和错误码均拒绝且异常不含输入', t => {
  const root = fixture(t), log = new ContinuityDiagnosticLog(root);
  for (const invalid of [
    { ...event(), entry: '私人姓名与正文' }, { ...event(), entry: 'history.privateName' },
    { ...event(), contactPrefix: '私人姓名与正文' }, { ...event(), contactPrefix: 'abcd1234-extra' },
    { ...event(), branch: 'N99' }, { ...event(), errorCode: 'history_privateName' },
    { ...event(), errorCode: 'history_source_changed\n私人正文' }, { ...event(), text: '私人正文' },
  ]) unavailable(() => log.append(invalid));
  unavailable(() => log.erase('私人姓名与正文'));
  assert.deepEqual(records(root), []);
});

test('日志目录和文件拒绝符号链接、硬链接、非普通文件和不安全权限', async t => {
  for (const kind of ['directory_symlink', 'root_symlink', 'directory_permissions', 'file_symlink', 'archive_symlink', 'hardlink', 'nonfile', 'file_permissions']) {
    await t.test(kind, t => {
      const root = fixture(t), outside = fixture(t), target = path.join(outside, 'sentinel');
      writeFileSync(target, '不应改变的外部文件', { mode: 0o600 });
      const directory = path.join(root, 'logs'), current = files(root)[0];
      if (kind === 'root_symlink') {
        const alias = path.join(outside, 'alias');
        symlinkSync(root, alias);
        unavailable(() => new ContinuityDiagnosticLog(alias).prune());
      } else {
        if (kind === 'directory_symlink') symlinkSync(outside, directory);
        else {
          mkdirSync(directory, { mode: 0o700 });
          if (kind === 'directory_permissions') chmodSync(directory, 0o755);
          if (kind === 'file_symlink') symlinkSync(target, current);
          if (kind === 'archive_symlink') symlinkSync(target, files(root)[2]);
          if (kind === 'hardlink') linkSync(target, current);
          if (kind === 'nonfile') mkdirSync(current, { mode: 0o700 });
          if (kind === 'file_permissions') writeFileSync(current, '', { mode: 0o644 });
        }
        unavailable(() => new ContinuityDiagnosticLog(root).prune());
      }
      assert.equal(readFileSync(target, 'utf8'), '不应改变的外部文件');
    });
  }
});

test('追加和删除重新核验路径，拒绝运行中被替换的文件与超大日志', t => {
  const root = fixture(t), log = new ContinuityDiagnosticLog(root, { maxBytes: 256 });
  log.append(event());
  const outside = fixture(t), target = path.join(outside, 'sentinel');
  writeFileSync(target, '不应改变的外部文件', { mode: 0o600 });
  rmSync(files(root)[0]);
  symlinkSync(target, files(root)[0]);
  unavailable(() => log.append(event()));
  unavailable(() => log.erase('abcd1234'));
  unavailable(() => log.erase());
  assert.equal(readFileSync(target, 'utf8'), '不应改变的外部文件');
  rmSync(files(root)[0]);
  writeFileSync(files(root)[0], Buffer.alloc(257), { mode: 0o600 });
  unavailable(() => log.prune());
  unavailable(() => log.erase('abcd1234'));
});

test('原地恢复和故障补记新增围栏保留实际入口的白名单诊断',t=>{
 const root=fixture(t),log=new ContinuityDiagnosticLog(root);
 log.append({entry:'history.prepareRecoveredGuard',contactPrefix:'abcd1234',branch:'N04'});
 log.append({entry:'history.recertifyNoteFailure',contactPrefix:'abcd1234',branch:'C01',errorCode:'history_source_changed'});
 assert.deepEqual(records(root).map(row=>row.entry),['history.prepareRecoveredGuard','history.recertifyNoteFailure']);
});
