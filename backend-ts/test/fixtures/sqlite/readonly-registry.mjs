import {registry as base} from '../../../src/storage/sqlite/registry.ts';
let remembered;

// 合成读写与长查询只验证附属读者，不包含业务资料或模型调用。
export const registry={migrations:[base.migrations[0],{version:2,sql:`
CREATE TABLE reader_fact (id INTEGER PRIMARY KEY,value INTEGER NOT NULL) STRICT;
INSERT INTO reader_fact VALUES(1,7);
`}],actions:[
 {name:'reader.value',mode:'read',retryBusy:false,execute:tx=>tx.get('SELECT value FROM reader_fact WHERE id=1').value},
 {name:'reader.lease',mode:'read',retryBusy:false,execute:(_tx,_input,lease)=>lease},
 {name:'reader.save',mode:'write',retryBusy:false,execute(tx,input){tx.run('UPDATE reader_fact SET value=? WHERE id=1',[input]);return true;}},
 {name:'reader.slow',mode:'read',retryBusy:false,execute(tx,input){
  const started=new Int32Array(input.started);Atomics.store(started,0,1);Atomics.notify(started,0);
  return tx.get('WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<12000000) SELECT sum(x) AS total FROM n').total;
 }},
 {name:'reader.illegalWrite',mode:'read',retryBusy:false,execute(tx){tx.run('UPDATE reader_fact SET value=0');return true;}},
 {name:'reader.illegalSqlWrite',mode:'read',retryBusy:false,execute:tx=>tx.all('UPDATE reader_fact SET value=0 RETURNING value')},
 {name:'reader.remember',mode:'read',retryBusy:false,execute(tx){remembered=tx;return true;}},
 {name:'reader.useRemembered',mode:'read',retryBusy:false,execute:()=>remembered.get('SELECT value FROM reader_fact WHERE id=1').value},
 {name:'reader.hold',mode:'read',retryBusy:false,execute(tx,input){
  const value=tx.get('SELECT value FROM reader_fact WHERE id=1').value,barrier=new Int32Array(input.barrier);
  Atomics.store(barrier,0,1);Atomics.notify(barrier,0);Atomics.wait(barrier,1,0,5000);return value;
 }},
 {name:'reader.compact',mode:'maintenance',retryBusy:false,execute(){return true;}},
 {name:'reader.checkpoint',mode:'maintenance',retryBusy:false,execute:maintenance=>maintenance.checkpoint().busy},
 {name:'reader.crash',mode:'read',retryBusy:false,execute(){process.exit(42);}},
]};
