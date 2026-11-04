import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {replySourceValidationSql} from '../src/reply/sqlite/candidates/input.ts';

// 与正式 message 表相同的键结构；规划器若退化为按 owner 扫描，真实库上每次约1.6秒并占满唯一写者。
function messageTable(){
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE message (owner_id TEXT NOT NULL,id TEXT NOT NULL,contact_id TEXT NOT NULL,interpretation_revision INTEGER NOT NULL DEFAULT 1,
  availability TEXT NOT NULL DEFAULT 'available',PRIMARY KEY(owner_id,id),UNIQUE(owner_id,contact_id,id)) STRICT`);
 return db;
}

test('来源校验按 owner、联系人、消息键逐行查找，不按 owner 扫描消息表',()=>{
 const db=messageTable(),plan=db.prepare('EXPLAIN QUERY PLAN '+replySourceValidationSql(50)).all(...Array(151).fill('x')).map(row=>String(row.detail)).join('\n');
 assert.match(plan,/SEARCH m USING (?:COVERING )?INDEX \S+ \(owner_id=\? AND contact_id=\? AND id=\?\)/,plan);
 assert.doesNotMatch(plan,/SCAN m/,plan);
});

test('来源校验统计同一接纳修订的可用消息，失效或改版的消息不计入',()=>{
 const db=messageTable(),add=db.prepare('INSERT INTO message(owner_id,id,contact_id,interpretation_revision,availability) VALUES(?,?,?,?,?)');
 add.run('o','m1','c',1,'available');add.run('o','m2','c',2,'available');add.run('o','m3','c',1,'deleting');
 const count=rows=>db.prepare(replySourceValidationSql(rows.length)).get(...rows.flat(),'o').n;
 assert.equal(count([['c','m1',1],['c','m2',2]]),2);
 assert.equal(count([['c','m1',2],['c','m3',1],['d','m1',1],['c','missing',1]]),0);
});
