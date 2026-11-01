import {memoryAdjudicationMigration} from '../../memory/sqlite/management/adjudication-schema.ts';
import {memoryDocumentsMigration} from '../../memory/sqlite/documents/schema.ts';
import {memoryDocumentsActions} from '../../memory/sqlite/documents/actions.ts';
import {memoryDocumentsStageActions} from '../../memory/sqlite/documents/stages.ts';
import {memoryDocumentsPublicationActions} from '../../memory/sqlite/documents/publication.ts';
import {laterScheduleMigration,memoryDocumentsLaterScheduleActions} from '../../memory/sqlite/documents/later-schedule.ts';
import {memoryIncrementalBaselineMigration} from '../../memory/sqlite/incremental-baseline-schema.ts';
import {memoryAdjudicationActions} from '../../memory/sqlite/management/adjudication-actions.ts';
import {memoryManagementMigration} from '../../memory/sqlite/management/schema.ts';
import {memoryManagementActions} from '../../memory/sqlite/management/actions.ts';
import {replyCandidateMigration} from '../../reply/sqlite/candidates/schema.ts';
import {createReplyCandidateActions} from '../../reply/sqlite/candidates/actions.ts';
import {combinedKnowledgeReader} from '../../memory/sqlite/documents/knowledge.ts';
import {discussionActions} from '../../reply/sqlite/actions.ts';
import {discussionRequestActions} from '../../reply/sqlite/requests.ts';
import {runtimeActions} from '../../reply/sqlite/runtime-actions.ts';
import {discussionModelActions} from '../../reply/sqlite/model-actions.ts';
import { discussionMigration } from '../../reply/sqlite/schema.ts';
import { executionActions } from '../../memory/sqlite/execution.ts';
import { memoryExecutionMigration } from '../../memory/sqlite/execution-schema.ts';
import { runActions } from '../../memory/sqlite/runs.ts';
import { memoryExtractionMigration } from '../../memory/sqlite/schema.ts';
import { mediaMigration } from '../../media/sqlite/schema.ts';
import { createMediaActions } from '../../media/sqlite/actions.ts';
import { historyMigration } from '../../history/sqlite/schema.ts';
import { historyIncrementalMigration } from '../../history/sqlite/incremental-schema.ts';
import { historyClearMigration } from '../../history/sqlite/clear-schema.ts';
import { historyContinuityMigration } from '../../history/sqlite/continuity-schema.ts';
import { historyStateMigration } from '../../history/sqlite/state-schema.ts';
import { historyGuardMigration } from '../../history/sqlite/guard-schema.ts';
import { historyAcceptanceOrderMigration } from '../../history/sqlite/acceptance-order-schema.ts';
import { historyObservationIndexMigration } from '../../history/sqlite/observation-index-schema.ts';
import { historyTerminalMigration } from '../../history/sqlite/terminal-schema.ts';
import { historySingleTextCopyMigration } from '../../history/sqlite/single-text-copy-schema.ts';
import { historyQuoteMigration, historyQuoteRevisionMigration } from '../../history/sqlite/quote-schema.ts';
import { historyClearActions } from '../../history/sqlite/clear-actions.ts';
import { historyQuoteActions } from '../../history/sqlite/quote-store.ts';
import { historyActions } from '../../history/sqlite/actions.ts';
import { identityMigration } from '../../contacts/sqlite/schema.ts';
import { identityActions } from '../../contacts/sqlite/actions.ts';
import type { StorageRegistry } from './contracts.ts';
import { deletionMigration } from './deletion/schema.ts';
import { createDeletionActions } from './deletion/actions.ts';
import { installedDeletionRegistration, installedDeletionActions } from './deletion/registration.ts';
import { skillSchemaSql,skillDefaultEnablementMigration,skillDefaultQualificationMigration,skillActions } from '../../skills/sqlite/storage.ts';
import { cutoverActions } from '../../platform/cutover/inspect.ts';
import { modelUsageSummaryActions } from '../../platform/models/usage-summary.ts';

// 已发布版本不可修改；后续业务票在此追加连续版本及具名动作。
export const registry: StorageRegistry = {
  migrations: [{ version: 1, sql: `
CREATE TABLE database_instance (
  slot INTEGER PRIMARY KEY CHECK(slot=1),
  database_id TEXT NOT NULL UNIQUE,
  format_family TEXT NOT NULL CHECK(format_family='notalone-sqlite-v1'),
  role TEXT NOT NULL CHECK(role IN ('business','test')),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  runtime_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK(epoch>=0),
  schema_digest TEXT NOT NULL
) STRICT;
CREATE TABLE schema_migration (
  version INTEGER PRIMARY KEY CHECK(version>0),
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL CHECK(applied_at>=0)
) STRICT;
` }, deletionMigration(2), identityMigration(3), {version:4,sql:skillSchemaSql}, historyMigration(5), mediaMigration(6), discussionMigration(7), memoryExtractionMigration(8), memoryExecutionMigration(9), replyCandidateMigration(10), memoryManagementMigration(11), memoryAdjudicationMigration(12), memoryDocumentsMigration(13), historyIncrementalMigration(14), historyClearMigration(15), historyContinuityMigration(16), historyStateMigration(17),historyGuardMigration(18),historyObservationIndexMigration(19),historyAcceptanceOrderMigration(20),historyTerminalMigration(21),historySingleTextCopyMigration(22),skillDefaultEnablementMigration,skillDefaultQualificationMigration,historyQuoteMigration(25),historyQuoteRevisionMigration(26),laterScheduleMigration(27),memoryIncrementalBaselineMigration(28)],
  actions: [...memoryDocumentsLaterScheduleActions,...memoryDocumentsActions, ...memoryDocumentsStageActions, ...memoryDocumentsPublicationActions, ...memoryAdjudicationActions, ...memoryManagementActions, ...createReplyCandidateActions(combinedKnowledgeReader), ...discussionActions, ...discussionRequestActions, ...runtimeActions, ...discussionModelActions, ...runActions, ...executionActions, ...modelUsageSummaryActions, ...createDeletionActions(installedDeletionRegistration), ...installedDeletionActions, ...identityActions, ...skillActions, ...historyActions, ...historyClearActions, ...historyQuoteActions, ...createMediaActions(installedDeletionRegistration), ...cutoverActions],
};
