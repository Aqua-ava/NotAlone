import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {historySingleTextCopyMigration} from '../src/storage/sqlite/migrations/history-single-text-copy.ts';

test('旧来源正文完全一致时去重，不一致的历史内容及不可变保护保留',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec(`CREATE TABLE message(owner_id TEXT,contact_id TEXT,id TEXT,kind TEXT,text_body TEXT);
   CREATE TABLE capture_record(owner_id TEXT,id TEXT,contact_id TEXT,capture_id TEXT,item_no INTEGER,state TEXT,message_id TEXT,raw_payload TEXT,observed_scheme TEXT,observed_key TEXT,normalizer_version TEXT,reason_code TEXT);
   CREATE TRIGGER capture_record_immutable BEFORE UPDATE OF owner_id,id,contact_id,capture_id,item_no,state,message_id,raw_payload,observed_scheme,observed_key,normalizer_version,reason_code ON capture_record WHEN OLD.state IN ('normalized','excluded') BEGIN SELECT RAISE(ABORT,'capture_record_immutable'); END;
   INSERT INTO message VALUES('o','c','m','text','正文');
   INSERT INTO capture_record VALUES('o','same','c','a',0,'normalized','m','{"kind":"text","text":"正文"}',NULL,NULL,'1',NULL),('o','different','c','a',1,'normalized','m','{"kind":"text","text":"旧内容"}',NULL,NULL,'1',NULL);`);
  db.exec('BEGIN');db.exec(historySingleTextCopyMigration(22).sql);db.exec('COMMIT');
  const rows=db.prepare('SELECT id,raw_payload,normalizer_version FROM capture_record ORDER BY id').all();
  assert.equal(rows[0].normalizer_version,'1');assert.equal(JSON.parse(rows[0].raw_payload).text,'旧内容');
  assert.equal(rows[1].normalizer_version,'2');assert.equal(JSON.parse(rows[1].raw_payload).text,null);
  assert.throws(()=>db.exec("UPDATE capture_record SET raw_payload='{}' WHERE id='same'"),/capture_record_immutable/);
 }finally{db.close();}
});
