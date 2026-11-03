import {registry as base} from '../../../src/storage/sqlite/registry.ts';

export const registry={migrations:base.migrations,actions:[...base.actions,{
 name:'foregroundTest.scan',mode:'read',retryBusy:false,execute(tx,input){
  const ready=new Int32Array(input.ready);Atomics.store(ready,0,1);Atomics.notify(ready,0);
  // 真正占用原存储线程的长查询，前台读者必须在它结束前完成。
  return tx.get('WITH RECURSIVE sequence(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM sequence WHERE n<8000000) SELECT sum(n) AS total FROM sequence').total;
 }
},{
 name:'foregroundTest.removeContact',mode:'write',retryBusy:false,execute(tx,input){
  tx.run("UPDATE contact SET state='deleting',data_generation=data_generation+1 WHERE owner_id=? AND id=?",[input.ownerId,input.contactId]);
  return null;
 }
}]};
