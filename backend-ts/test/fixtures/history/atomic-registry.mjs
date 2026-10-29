import { registry as base } from '../../../src/storage/sqlite/registry.ts';
import { historyActions } from '../../../src/history/sqlite/actions.ts';
const accept=historyActions.find(a=>a.name==='history.acceptPage');
export const registry={migrations:base.migrations,actions:[...base.actions,
 {name:'fixture.acceptThenFail',mode:'write',retryBusy:false,execute(tx,input,lease){accept.execute(tx,input,lease);throw new Error('synthetic_commit_failure');}},
 {name:'fixture.constraints',mode:'write',retryBusy:false,execute(tx,i){
  if(i.kind==='body')tx.run('UPDATE message SET text_body=? WHERE owner_id=? AND id=?',['篡改',i.owner,i.message]);
  else if(i.kind==='alias')tx.run("INSERT INTO message_alias VALUES(?,?,?,'server','999',?)",[i.owner,i.contact,i.binding,i.message]);
  else tx.run('UPDATE capture_record SET message_id=? WHERE owner_id=? AND id=?',[i.message,i.owner,i.record]);
 }}]};
