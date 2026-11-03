import {createHash} from 'node:crypto';
import type {StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import type {MemoryScope} from './contracts.ts';
import {available,fail,id} from './qualification.ts';

export const managementPageSize=20;
export interface ManagementPageScope {ownerId:string;scope:MemoryScope;displayContactId:string|null;revision:string}
export function pageScope(tx:StorageTransaction,ownerId:string,scope:MemoryScope,displayContactId?:string):ManagementPageScope {
 available(tx,ownerId,scope);
 const display=displayContactId===undefined?null:id(displayContactId);
 if(display!==null)available(tx,ownerId,{scopeKind:'contact',contactId:display});
 if(scope.scopeKind==='contact'&&display!==null&&display!==scope.contactId)fail('memory_scope_invalid');
 const memory=scope.scopeKind==='self'?tx.get('SELECT management_revision FROM owner WHERE owner_id=?',[ownerId]):tx.get('SELECT management_revision FROM contact WHERE owner_id=? AND id=?',[ownerId,scope.contactId]);
 const contact=scope.contactId??display;
 const source=contact===null?null:tx.get('SELECT source_revision,selection_generation,data_generation FROM contact WHERE owner_id=? AND id=?',[ownerId,contact]);
 const owner=tx.get('SELECT read_epoch,state FROM owner WHERE owner_id=?',[ownerId]);
 const revision=createHash('sha256').update(JSON.stringify([memory,source,owner],(_key,value)=>typeof value==='bigint'?String(value):value)).digest('hex');
 return {ownerId,scope,displayContactId:display,revision};
}
export function encodePage(scope:ManagementPageScope,kind:string,position:unknown):string {
 return Buffer.from(JSON.stringify([1,scope.ownerId,scope.scope.scopeKind,scope.scope.contactId,scope.displayContactId,scope.revision,kind,position])).toString('base64url');
}
export function decodePage(scope:ManagementPageScope,kind:string,cursor:unknown):unknown {
 if(typeof cursor!=='string'||cursor.length>4096||!cursor.length||!/^[A-Za-z0-9_-]+$/.test(cursor))fail('memory_page_stale');
 try{
  const value=JSON.parse(Buffer.from(cursor as string,'base64url').toString('utf8'));
  if(!Array.isArray(value)||value.length!==8||JSON.stringify(value.slice(0,7))!==JSON.stringify([1,scope.ownerId,scope.scope.scopeKind,scope.scope.contactId,scope.displayContactId,scope.revision,kind]))fail('memory_page_stale');
  return value[7];
 }catch{return fail('memory_page_stale');}
}
