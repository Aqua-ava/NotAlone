import {createHash} from 'node:crypto';
import type {RowDeletionTarget} from '../../storage/sqlite/deletion/contracts.ts';

/** 历史域行目标的身份与构造，供统一删除的各个范围共用，保证 clearRow 复验的身份一致。 */
export const rowIdentity=(kind:string,key:Record<string,string>):string=>createHash('sha256').update(JSON.stringify([kind,Object.keys(key).sort().map(k=>[k,key[k]])])).digest('hex');
export const historyTarget=(kind:string,key:Record<string,string>):RowDeletionTarget=>({kind:'row',domain:'history',rowKind:kind,key,identity:rowIdentity(kind,key),holderKeys:[]});
