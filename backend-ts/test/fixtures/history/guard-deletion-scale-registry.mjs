import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {getSourceGuard,putSourceGuard} from '../../../src/history/sqlite/source-guard.ts';
const ownerId='synthetic-scale-owner';
const contactId=n=>`synthetic-scale-contact-${n}`;
export const registry={...base,actions:[...base.actions,
 {name:'fixture.seedGuardContacts',mode:'write',retryBusy:false,execute(tx,i){
  tx.run('INSERT INTO owner(owner_id,created_at) VALUES(?,0)',[ownerId]);
  for(let n=0;n<i.count;n++)tx.run('INSERT INTO contact(owner_id,id) VALUES(?,?)',[ownerId,contactId(n)]);
  return ownerId;
 }},
 {name:'fixture.seedGuardBatch',mode:'write',retryBusy:false,execute(tx,i){
  for(let n=i.start;n<i.end;n++)putSourceGuard(tx,{owner_id:ownerId,contact_id:contactId(n),binding_id:`binding-${n}`,
   conversation_id:`conversation-${n}`,source_generation:'synthetic-source',guard_id:`guard-${n}`,runtime_id:'synthetic-runtime',state:'active'});
  return null;
 }},
 {name:'fixture.guardScaleSnapshot',mode:'read',retryBusy:false,execute(tx,i){
  let guards=0;for(let n=0;n<i.count;n++)if(getSourceGuard(tx,ownerId,contactId(n)))guards++;
  return {guards,contacts:tx.get('SELECT count(*) n FROM contact WHERE owner_id=?',[ownerId]).n,
   active:tx.get("SELECT count(*) n FROM contact WHERE owner_id=? AND state='active'",[ownerId]).n,
   deleted:tx.get("SELECT count(*) n FROM contact WHERE owner_id=? AND state='deleted'",[ownerId]).n};
 }},
]};
