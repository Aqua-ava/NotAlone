import {registry as base} from './discussion-registry.mjs';
export const registry={...base,actions:[...base.actions,
 {name:'abandonTest.ledger',mode:'read',retryBusy:false,execute(tx,i){return {
  calls:tx.all('SELECT * FROM model_call WHERE owner_id=?',[i.ownerId]),
  operations:tx.all('SELECT * FROM model_operation WHERE owner_id=?',[i.ownerId]),
  scopes:tx.all('SELECT * FROM operation_scope WHERE owner_id=?',[i.ownerId]),
  contexts:tx.all('SELECT id FROM reply_context WHERE owner_id=?',[i.ownerId]),
  requests:tx.all('SELECT id FROM reply_request WHERE owner_id=?',[i.ownerId]),
 };}},
]};
