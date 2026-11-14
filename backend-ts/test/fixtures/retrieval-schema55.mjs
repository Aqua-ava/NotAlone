import {registry as current} from '../../src/storage/sqlite/registry.ts';
import {createDeletionActions} from '../../src/storage/sqlite/deletion/actions.ts';
import {installedDeletionRegistration} from '../../src/storage/sqlite/deletion/registration.ts';
// 合成升级夹具固定保留56之前的实际迁移链，不复制或改写已发布SQL。
const oldDeletion=createDeletionActions({...installedDeletionRegistration,domains:installedDeletionRegistration.domains.filter(d=>d.id!=='retrieval_index'),requiredDomains:installedDeletionRegistration.requiredDomains.filter(d=>d!=='retrieval_index')});
const replacements=new Map(oldDeletion.map(action=>[action.name,action]));
export const registry={...current,migrations:current.migrations.filter(m=>m.version<=55),actions:current.actions.map(action=>replacements.get(action.name)??action)};
