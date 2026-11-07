import {registry as base} from '../../../src/storage/sqlite/registry.ts';

// legacy 只截取到 44（新增 superseded_history 范围之前）；升级执行沿正式迁移 45 及后续结构。
// 旧结构仅用历史DDL种子动作，不调用依赖source_proof的现代目录或同步入口。
const legacy=new URL(import.meta.url).searchParams.get('mode')==='legacy';
const seedIdentity={name:'fixture.seedLedgerIdentity44',mode:'write',retryBusy:false,execute(tx,{ownerId,contactId}){
 tx.run('INSERT INTO owner(owner_id,created_at) VALUES(?,1)',[ownerId]);tx.run('INSERT INTO contact(owner_id,id) VALUES(?,?)',[ownerId,contactId]);return contactId;
}};
export const registry={...base,migrations:legacy?base.migrations.filter(migration=>migration.version<=44):base.migrations,actions:[...base.actions,seedIdentity]};
