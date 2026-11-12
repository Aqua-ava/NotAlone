import {sourceEligibility,eligibleReferences,type SourceEligibility} from './source.ts';
import {savedSourceScopeCTE} from './current-scope.ts';
import type {StorageTransaction} from '../../storage/sqlite/contracts.ts';
import type {MessageSourceReference} from './contracts.ts';

const scopedSources=new WeakMap<StorageTransaction,Set<string>>();
const sourceKey=(ref:MessageSourceReference)=>JSON.stringify([ref.owner_id,ref.contact_id,ref.record_id,ref.message_id]);
/** 同步存储动作内复用来源资格；任何写入先作废，退出后不保留证明。 */
export function withReplyLocalSourceEligibility<T>(tx:StorageTransaction,work:(scoped:StorageTransaction)=>T):T{
 if(scopedSources.has(tx))return work(tx);
 const verified=new Set<string>(),scoped:StorageTransaction={...tx,
  run(sql,values){verified.clear();tx.run(sql,values);},
  ...(tx.flushDerived?{flushDerived(){verified.clear();tx.flushDerived!();}}:{}),
 };
 scopedSources.set(scoped,verified);
 try{return work(scoped);}finally{scopedSources.delete(scoped);}
}

/** 已保存回复资料：核对归属、接纳范围、删除、隔离和真实围栏，不读取微信或复活未知旧证明。 */
const assertSavedSources=sourceEligibility(savedSourceScopeCTE);
export function assertReplyLocalSources(tx:StorageTransaction,refs:readonly MessageSourceReference[]):void{
 const verified=scopedSources.get(tx);
 if(!verified){assertSavedSources(tx,refs);return;}
 const missing=refs.filter(ref=>!verified.has(sourceKey(ref)));
 if(!missing.length)return;
 assertSavedSources(tx,missing);
 for(const ref of missing)verified.add(sourceKey(ref));
}
export const assertReplyLocalSource:SourceEligibility=(tx,ref)=>assertReplyLocalSources(tx,[ref]);

/** 与逐条本地断言使用同一保存范围，只保留本批仍合法的来源。 */
export const eligibleReplyLocalSourceReferences=eligibleReferences(savedSourceScopeCTE);
