import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {installedDeletionRegistration} from '../../../src/storage/sqlite/deletion/registration.ts';
import {createDeletionActions} from '../../../src/storage/sqlite/deletion/actions.ts';
const config={...installedDeletionRegistration,domains:installedDeletionRegistration.domains.filter(d=>d.id!=='memory_documents'),requiredDomains:[...new Set(['memory_documents',...installedDeletionRegistration.requiredDomains])]};
const actions=createDeletionActions(config),replaced=new Set(actions.map(a=>a.name));
export const registry={...base,actions:[...base.actions.filter(a=>!replaced.has(a.name)),...actions]};
