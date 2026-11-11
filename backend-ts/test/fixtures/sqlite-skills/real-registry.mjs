import {randomUUID} from 'node:crypto';
import {registry as base} from '../../../src/storage/sqlite/registry.ts';

const action=name=>base.actions.find(item=>item.name===name);
/**
 * 正式 registry 加一个仅测试用的授权动作：为合成联系人建立有效联系人行，并放入绑定全部已发现 Skill 的分组。
 * 生产路径通过联系人确认和分组管理完成同样的事；这里只服务不经完整联系人流程的 Skill 机制测试。
 */
export const registry={...base,actions:[...base.actions,
 {name:'fixture.grantSkills',mode:'write',retryBusy:false,execute(tx,i,lease){
  tx.run("INSERT OR IGNORE INTO contact(owner_id,id,display_name) VALUES(?,?,'合成联系人')",[i.ownerId,i.contactId]);
  const ids=tx.all('SELECT id FROM skill_package WHERE owner_id=? ORDER BY id',[i.ownerId]).map(row=>row.id);
  let group=tx.get("SELECT id FROM skill_group WHERE owner_id=? AND name='fixture-all'",[i.ownerId]);
  if(!group){const created=action('skillGroups.create').execute(tx,{ownerId:i.ownerId,id:randomUUID(),name:'fixture-all',packageIds:ids,at:0n},lease);group={id:created.id};}
  const current=tx.get('SELECT group_id FROM contact_skill_group WHERE owner_id=? AND contact_id=?',[i.ownerId,i.contactId])?.group_id??null;
  action('skillGroups.assign').execute(tx,{ownerId:i.ownerId,contactId:i.contactId,groupId:group.id,expectedGroupId:current},lease);
 }},
]};
