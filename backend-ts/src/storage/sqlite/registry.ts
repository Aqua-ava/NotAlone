import {historyRetirementMigration} from './migrations/history-retirement-schema.ts';
import {historySourceProofMigration} from './migrations/history-source-proof.ts';
import {createReplyKnowledgeStorageRegistry} from '../../reply/sqlite/candidates/knowledge-context.ts';
import {createMemoryContentStorageRegistry} from '../../memory/content/storage.ts';
import {builtinMemoryContentPlugins} from '../../memory/content/builtins.ts';
import {memoryContentMigration} from '../../memory/sqlite/content-schema.ts';
import {memoryContentCitationMigration} from '../../memory/sqlite/content-citation-schema.ts';
import {historyRecertifyMigration,historyRecertifyCancelMigration} from './migrations/history-recertify.ts';
import {memoryAdjudicationMigration} from '../../memory/sqlite/management/adjudication-schema.ts';
import {memoryDocumentsMigration} from '../../memory/sqlite/documents/schema.ts';
import {memoryDocumentsActions} from '../../memory/sqlite/documents/actions.ts';
import {memoryDocumentsStageActions} from '../../memory/sqlite/documents/stages.ts';
import {memoryDocumentsPublicationActions} from '../../memory/sqlite/documents/publication.ts';
import {laterScheduleMigration,memoryDocumentsLaterScheduleActions} from '../../memory/sqlite/documents/later-schedule.ts';
import {memoryIncrementalBaselineMigration} from '../../memory/sqlite/incremental-baseline-schema.ts';
import {memoryAutoProcessingMigration} from '../../memory/sqlite/auto-processing.ts';
import {memoryAdjudicationActions} from '../../memory/sqlite/management/adjudication-actions.ts';
import {memoryManagementMigration} from '../../memory/sqlite/management/schema.ts';
import {memoryManagementPaginationMigration} from '../../memory/sqlite/management/pagination-schema.ts';
import {memoryManagementTimelineMigration} from '../../memory/sqlite/management/timeline-schema.ts';
import {memoryManagementTimelineMaintenanceMigration} from '../../memory/sqlite/management/timeline-maintenance-schema.ts';
import {memoryManagementTimelineProjectionMigration} from '../../memory/sqlite/management/timeline-projection-schema.ts';
import {memoryManagementTimelineRepairMigration} from '../../memory/sqlite/management/timeline-repair-schema.ts';
import {memoryManagementPendingIndexMigration} from '../../memory/sqlite/management/pending-index-schema.ts';
import {memoryManagementActions} from '../../memory/sqlite/management/actions.ts';
import {replyCandidateMigration} from '../../reply/sqlite/candidates/schema.ts';
import {createReplyCandidateActions} from '../../reply/sqlite/candidates/actions.ts';
import {replyLocalKnowledgeReader} from '../../memory/sqlite/documents/knowledge.ts';
import {discussionActions} from '../../reply/sqlite/actions.ts';
import {discussionRequestActions} from '../../reply/sqlite/requests.ts';
import {runtimeActions} from '../../reply/sqlite/runtime-actions.ts';
import {discussionModelActions} from '../../reply/sqlite/model-actions.ts';
import { discussionMigration } from '../../reply/sqlite/schema.ts';
import { executionActions } from '../../memory/sqlite/execution.ts';
import { memoryExecutionMigration } from '../../memory/sqlite/execution-schema.ts';
import { runActions } from '../../memory/sqlite/runs.ts';
import { memoryExtractionMigration, memoryExecutionPlannedStepIndexMigration } from '../../memory/sqlite/schema.ts';
import { mediaMigration, mediaImageQualityEvidenceMigration } from '../../media/sqlite/schema.ts';
import { createMediaActions } from '../../media/sqlite/actions.ts';
import { historyMigration } from './migrations/history-base.ts';
import { historyIncrementalMigration } from './migrations/history-incremental.ts';
import { historyClearMigration } from './migrations/history-clear.ts';
import { historyContinuityMigration } from './migrations/history-continuity.ts';
import { historyStateMigration } from './migrations/history-state.ts';
import { historyGuardMigration } from './migrations/history-guard.ts';
import { supersededHistoryMigration } from './migrations/history-superseded.ts';
import { historyAcceptanceOrderMigration } from './migrations/history-acceptance-order.ts';
import { historyObservationIndexMigration } from './migrations/history-observation-index.ts';
import { historyEmptyCaptureMigration, historyCaptureRecordForeignKeyIndexMigration, historyMessageAliasIndexMigration } from './migrations/history-empty-capture.ts';
import { historyTerminalMigration } from './migrations/history-terminal.ts';
import { historySingleTextCopyMigration } from './migrations/history-single-text-copy.ts';
import { historyQuoteMigration, historyQuoteRevisionMigration } from './migrations/history-quote.ts';
import { historyClearActions } from '../../history/sqlite/clear-actions.ts';
import { historyQuoteActions } from '../../history/sqlite/quote-store.ts';
import { historyActions } from '../../history/sqlite/actions.ts';
import { identityMigration } from '../../contacts/sqlite/schema.ts';
import { identityActions } from '../../contacts/sqlite/actions.ts';
import type { StorageRegistry } from './contracts.ts';
import { backgroundReadBoundaryAction } from './background-reads.ts';
import { deletionMigration } from './deletion/schema.ts';
import { createDeletionActions } from './deletion/actions.ts';
import { installedDeletionRegistration, installedDeletionActions } from './deletion/registration.ts';
import { skillSchemaSql,skillDefaultEnablementMigration,skillDefaultQualificationMigration,skillActions } from '../../skills/sqlite/storage.ts';
import { cutoverActions } from '../../platform/cutover/inspect.ts';
import { modelUsageSummaryActions } from '../../platform/models/usage-summary.ts';

// 已发布版本不可修改；后续业务票在此追加连续版本及具名动作。
export const registry: StorageRegistry = createReplyKnowledgeStorageRegistry(createMemoryContentStorageRegistry({
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
` }, deletionMigration(2), identityMigration(3), {version:4,sql:skillSchemaSql}, historyMigration(5), mediaMigration(6), discussionMigration(7), memoryExtractionMigration(8), memoryExecutionMigration(9), replyCandidateMigration(10), memoryManagementMigration(11), memoryAdjudicationMigration(12), memoryDocumentsMigration(13), historyIncrementalMigration(14), historyClearMigration(15), historyContinuityMigration(16), historyStateMigration(17),historyGuardMigration(18),historyObservationIndexMigration(19),historyAcceptanceOrderMigration(20),historyTerminalMigration(21),historySingleTextCopyMigration(22),skillDefaultEnablementMigration,skillDefaultQualificationMigration,historyQuoteMigration(25),historyQuoteRevisionMigration(26),laterScheduleMigration(27),memoryIncrementalBaselineMigration(28),historyRecertifyMigration(29),historyRecertifyCancelMigration(30),mediaImageQualityEvidenceMigration(31),memoryContentMigration(32),memoryContentCitationMigration(33),memoryManagementPaginationMigration(34),memoryManagementTimelineMigration(35),memoryManagementTimelineMaintenanceMigration(36),memoryManagementTimelineProjectionMigration(37),memoryManagementTimelineRepairMigration(38),memoryManagementPendingIndexMigration(39), historyEmptyCaptureMigration(40), historyCaptureRecordForeignKeyIndexMigration(41), memoryAutoProcessingMigration(42), historyMessageAliasIndexMigration(43), memoryExecutionPlannedStepIndexMigration(44), supersededHistoryMigration(45),historySourceProofMigration(46),historyRetirementMigration(47)],
  actions: [backgroundReadBoundaryAction,...memoryDocumentsLaterScheduleActions,...memoryDocumentsActions, ...memoryDocumentsStageActions, ...memoryDocumentsPublicationActions, ...memoryAdjudicationActions, ...memoryManagementActions, ...createReplyCandidateActions(replyLocalKnowledgeReader), ...discussionActions, ...discussionRequestActions, ...runtimeActions, ...discussionModelActions, ...runActions, ...executionActions, ...modelUsageSummaryActions, ...createDeletionActions(installedDeletionRegistration), ...installedDeletionActions, ...identityActions, ...skillActions, ...historyActions, ...historyClearActions, ...historyQuoteActions, ...createMediaActions(installedDeletionRegistration), ...cutoverActions],
},builtinMemoryContentPlugins),replyLocalKnowledgeReader);
