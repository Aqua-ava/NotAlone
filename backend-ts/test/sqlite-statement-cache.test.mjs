import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { statementCache } from '../src/storage/sqlite/statement-cache.ts';

test('同一条 SQL 复用同一预编译语句，结果按 BigInt 读取且每次重新取值', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t(k INTEGER PRIMARY KEY, v INTEGER); INSERT INTO t VALUES(1,10)');
  const prepared = statementCache(db);
  const first = prepared('SELECT v FROM t WHERE k=?');
  assert.equal(prepared('SELECT v FROM t WHERE k=?'), first);
  assert.deepEqual(first.all(1)[0].v, 10n);
  db.exec('UPDATE t SET v=11 WHERE k=1');
  assert.deepEqual(prepared('SELECT v FROM t WHERE k=?').all(1)[0].v, 11n, '缓存语句不能返回旧值');
  db.close();
});

test('超过容量时淘汰最久未用的语句，最近使用的保留', () => {
  const db = new DatabaseSync(':memory:');
  const prepared = statementCache(db, 2);
  const a = prepared('SELECT 1 AS a'), b = prepared('SELECT 2 AS b');
  prepared('SELECT 1 AS a');
  prepared('SELECT 3 AS c');
  assert.equal(prepared('SELECT 1 AS a'), a, '刚用过的 a 应保留');
  assert.notEqual(prepared('SELECT 2 AS b'), b, '最久未用的 b 应被淘汰并重新编译');
  db.close();
});

test('表结构变化后缓存语句自动重新编译，语法错误的 SQL 不进入缓存', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t(k INTEGER); INSERT INTO t VALUES(1)');
  const prepared = statementCache(db);
  assert.equal(prepared('SELECT * FROM t').all().length, 1);
  db.exec('ALTER TABLE t ADD COLUMN extra INTEGER DEFAULT 7');
  assert.equal(prepared('SELECT * FROM t').all()[0].extra, 7n);
  assert.throws(() => prepared('SELEC bad'));
  assert.throws(() => prepared('SELEC bad'));
  db.close();
});
