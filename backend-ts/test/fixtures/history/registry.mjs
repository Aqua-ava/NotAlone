import { assertSourceEligibility } from '../../../src/history/sqlite/source.ts';
import { registry as base } from '../../../src/storage/sqlite/registry.ts';
import { createDeletionActions } from '../../../src/storage/sqlite/deletion/actions.ts';
import { identityDeletionAuthority, identityDeletionDomain } from '../../../src/contacts/sqlite/deletion.ts';
import { historyDeletionDomain } from '../../../src/history/sqlite/deletion.ts';
const sourceAction={name:'fixture.assertSource',mode:'read',retryBusy:false,execute(tx,i){assertSourceEligibility(tx,i);return true;}};
export const registry={migrations:base.migrations,actions:[...base.actions.filter(a=>!a.name.startsWith('deletion.')),sourceAction,...createDeletionActions({authority:identityDeletionAuthority,domains:[historyDeletionDomain,identityDeletionDomain],requiredDomains:['identity','history']})]};
