import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {memoryExtractionMigration} from '../../../src/memory/sqlite/schema.ts';
import {memoryExecutionMigration} from '../../../src/memory/sqlite/execution-schema.ts';
import {memoryOwnerContributionMigration} from '../../../src/memory/sqlite/owner-schema.ts';
import {discussionMigration} from '../../../src/reply/sqlite/schema.ts';
import {discussionActions} from '../../../src/reply/sqlite/actions.ts';
import {discussionRequestActions} from '../../../src/reply/sqlite/requests.ts';
import {runtimeActions} from '../../../src/reply/sqlite/runtime-actions.ts';
import {discussionModelActions} from '../../../src/reply/sqlite/model-actions.ts';
const installed=base.migrations.some(m=>m.sql.includes('CREATE TABLE assistant_discussion'));
const migrations=installed?[...base.migrations]:[...base.migrations,discussionMigration(base.migrations.length+1)];
if(!migrations.some(m=>m.sql.includes('CREATE TABLE processing_run')))migrations.push(memoryExtractionMigration(migrations.length+1));
if(!migrations.some(m=>m.sql.includes('CREATE TABLE operation_scope')))migrations.push(memoryExecutionMigration(migrations.length+1));
if(!migrations.some(m=>m.sql.includes('CREATE TABLE self_contribution')))migrations.push(memoryOwnerContributionMigration(migrations.length+1));
export const registry={migrations,
 actions:[...base.actions,...[...discussionActions,...discussionRequestActions,...runtimeActions,...discussionModelActions].filter(a=>!base.actions.some(b=>b.name===a.name))]};
