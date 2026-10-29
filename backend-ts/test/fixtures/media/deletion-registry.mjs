import { registry as base } from '../../../src/storage/sqlite/registry.ts';
import { createDeletionActions } from '../../../src/storage/sqlite/deletion/actions.ts';
import { identityDeletionAuthority, identityDeletionDomain } from '../../../src/contacts/sqlite/deletion.ts';
import { historyDeletionDomain } from '../../../src/history/sqlite/deletion.ts';
import { createMediaActions } from '../../../src/media/sqlite/actions.ts';
import { mediaMigration } from '../../../src/media/sqlite/schema.ts';
import { composeMediaDeletionRegistration } from '../../../src/media/sqlite/deletion.ts';
const registration=composeMediaDeletionRegistration({authority:identityDeletionAuthority,domains:[historyDeletionDomain,identityDeletionDomain],requiredDomains:['history','identity']});
export const registry={migrations:base.migrations.some(m=>m.sql.includes('CREATE TABLE message_media'))?base.migrations:[...base.migrations,mediaMigration(base.migrations.length+1)],actions:[
 ...base.actions.filter(a=>!a.name.startsWith('deletion.')&&!a.name.startsWith('media.')),...createDeletionActions(registration),...createMediaActions(registration),
 {name:'fixture.mediaHead',mode:'write',retryBusy:false,execute(tx,i){tx.run("INSERT INTO message_media(owner_id,contact_id,message_id,media_generation,head_revision,state,created_at) VALUES(?,?,?,0,0,'active',?)",[i.ownerId,i.contactId,i.messageId,Date.now()]);}},
]};
