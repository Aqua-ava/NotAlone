import {registry as base} from './pagination-upgrade-registry.mjs';
const legacy=new URL(import.meta.url).searchParams.get('mode')==='legacy37';
export const registry={...base,migrations:legacy?base.migrations.filter(migration=>migration.version<=37):base.migrations,actions:[...base.actions,
 {name:'fixture.timelineCachedNull37',mode:'write',retryBusy:false,execute(tx,{ownerId,memoryId}){
  // 旧37在守卫失效时留下的持久状态；生产入口的原始失败由同文件另一用例覆盖。
  tx.run('UPDATE memory SET management_source_time=NULL,management_timeline_dirty=0 WHERE owner_id=? AND id=?',[ownerId,memoryId]);
 }},
]};
