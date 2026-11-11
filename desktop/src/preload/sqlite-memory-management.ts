import type {PageTransport} from './transport';
import type {SqliteMemoryManagementBridge,MemoryManagementDecision,MemoryManagementRead,MemoryHistoryRead} from '../shared/sqlite-memory-management';
export function createSqliteMemoryManagementBridge(transport:PageTransport):SqliteMemoryManagementBridge{
 const fail=()=>Promise.reject(new Error('记忆管理操作不可用。'));
 const traced=<T extends MemoryManagementRead>(value:T):T=>value&&typeof value==='object'?{...value,traceId:value.traceId??globalThis.crypto.randomUUID()}:value;
 return Object.freeze({
  read:(...args:[MemoryManagementRead])=>args.length===1?transport.invoke('memory:management-read',traced(args[0])):fail(),
  readHistory:(...args:[MemoryHistoryRead])=>args.length===1?transport.invoke('memory:history-read',traced(args[0])):fail(),
  readDocuments:(...args:[MemoryManagementRead])=>args.length===1?transport.invoke('memory:documents-read',traced(args[0])):fail(),
  decide:(...args:[MemoryManagementDecision])=>args.length===1?transport.invoke('memory:management-decide',traced(args[0])):fail(),
  release:(...args:unknown[])=>args.length===0?transport.invoke('memory:management-release'):fail(),
  onInvalidated:(listener:()=>void)=>{if(typeof listener!=='function')throw new Error('记忆管理读取不可用。');const receive=()=>listener();transport.on('memory:management-invalidated',receive);return()=>transport.removeListener('memory:management-invalidated',receive);},
 });
}
