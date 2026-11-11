import type {RowDeletionTarget} from '../../storage/sqlite/deletion/contracts.ts';
import {sha256StableJson,sortedEntries} from '../../platform/stable-json.ts';

/** 历史域行目标的身份与构造，供统一删除的各个范围共用，保证 clearRow 复验的身份一致。 */
/** 身份=[kind, [k,v]对数组]；本域 rowKinds 键集合是固定 ASCII 列名（owner_id/id/contact_id 等），键码点序与既有默认排序逐字节一致。 */
export const rowIdentity=(kind:string,key:Record<string,string>):string=>sha256StableJson([kind,sortedEntries(key)]);
export const historyTarget=(kind:string,key:Record<string,string>):RowDeletionTarget=>({kind:'row',domain:'history',rowKind:kind,key,identity:rowIdentity(kind,key),holderKeys:[]});
