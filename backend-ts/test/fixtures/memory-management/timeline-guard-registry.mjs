import {registry as current,paginationUpgradeActions} from './pagination-upgrade-registry.mjs';
import {loadPreSourceProofRegistry} from '../sqlite/pre-source-proof-registry.mjs';
const legacy=new URL(import.meta.url).searchParams.get('mode')==='legacy37';
const previous=legacy?await loadPreSourceProofRegistry():current,base=legacy?{...previous,actions:[...previous.actions,...paginationUpgradeActions]}:previous;
export const registry={...base,migrations:legacy?base.migrations.filter(migration=>migration.version<=37):base.migrations,actions:[...base.actions,
 {name:'fixture.markSourceDeleting',mode:'write',retryBusy:false,execute(tx,{ownerId,contactId}){
  // 模拟来源被真实删除／隔离：与守卫暂时失效不同，这类失效在本地资格中同样不通过。
  tx.run("UPDATE capture_record SET availability='deleting' WHERE owner_id=? AND contact_id=?",[ownerId,contactId]);
 }},
 {name:'fixture.timelineCachedNull37',mode:'write',retryBusy:false,execute(tx,{ownerId,memoryId}){
  // 旧37在守卫失效时留下的持久状态；生产入口的原始失败由同文件另一用例覆盖。
  tx.run('UPDATE memory SET management_source_time=NULL,management_timeline_dirty=0 WHERE owner_id=? AND id=?',[ownerId,memoryId]);
 }},
]};
