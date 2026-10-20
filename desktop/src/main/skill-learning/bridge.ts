import { noArguments, type PageCommands } from '../page-commands';
import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import type { ContactSelection } from '../../shared/contact-session-bridge';
import type { SkillPolicySelection, SkillReviewForm, SkillReviewSelection } from '../../shared/skill-learning-bridge';
import { readPolicyScope } from './policies';
import { isUuid } from '../uuid';
import { SkillLearningController } from './controller';
import { exactObject, readReviewForm } from './review-validation';

function selection(args: unknown[], configuration = false) {
  const row = args[0] as Record<string, unknown>;
  const keys = configuration ? ['contactId', 'scopeRevision', 'enabled', 'confirmed'] : ['contactId', 'scopeRevision'];
  if (args.length !== 1 || !row || typeof row !== 'object' || Array.isArray(row)
    || Object.keys(row).length !== keys.length || !Object.keys(row).every((key) => keys.includes(key))
    || !isUuid(row.contactId) || !Number.isSafeInteger(row.scopeRevision) || (row.scopeRevision as number) < 0
    || configuration && (typeof row.enabled !== 'boolean' || row.confirmed !== true)) throw new Error('经验整理操作无效。');
  return { ...row, contactId: row.contactId.toLowerCase() } as unknown as ContactSelection & { enabled: boolean; confirmed: true };
}
function reviewSelection(args: unknown[], action: 'open' | 'update' | 'save' | 'compare' | 'approve' | 'decision') {
  const keys = ['contactId', 'scopeRevision', 'draftId', ...(action === 'open' ? [] : ['expectedRevision']),
    ...(action === 'update' ? ['form'] : action === 'approve' ? ['comparisonId', 'confirmed', 'replacementsConfirmed'] : action === 'decision' ? ['decision'] : [])];
  const row = args[0];
  if (args.length !== 1 || !exactObject(row, keys) || !isUuid(row.contactId) || !isUuid(row.draftId)
    || !Number.isSafeInteger(row.scopeRevision) || (row.scopeRevision as number) < 0
    || action !== 'open' && (!Number.isSafeInteger(row.expectedRevision) || (row.expectedRevision as number) < 1)
    || action === 'approve' && (!isUuid(row.comparisonId) || row.confirmed !== true || row.replacementsConfirmed !== true)
    || action === 'decision' && !['reject', 'defer'].includes(row.decision as string)) throw new Error('审核操作无效。');
  return { ...row, contactId: row.contactId.toLowerCase(), draftId: row.draftId.toLowerCase(),
    ...(action === 'update' ? { form: readReviewForm(row.form, row.contactId.toLowerCase()) } : {}) } as unknown as SkillReviewSelection
      & { form: SkillReviewForm; comparisonId: string; confirmed: true; replacementsConfirmed: true; decision: 'reject' | 'defer' };
}
function rollbackSelection(args: unknown[]) {
  const row = args[0];
  if (args.length !== 1 || !exactObject(row, ['contactId', 'scopeRevision', 'skillId', 'versionId'])
    || !isUuid(row.contactId) || !isUuid(row.skillId) || !isUuid(row.versionId)
    || !Number.isSafeInteger(row.scopeRevision) || (row.scopeRevision as number) < 0) throw new Error('回滚操作无效。');
  return { contactId: row.contactId.toLowerCase(), scopeRevision: row.scopeRevision as number,
    skillId: row.skillId.toLowerCase(), versionId: row.versionId.toLowerCase() };
}
function policySelection(args: unknown[]): SkillPolicySelection {
  const row = args[0];
  if (args.length !== 1 || !exactObject(row, ['contactId', 'scopeRevision', 'skillId', 'versionId', 'methodId', 'policyScope'])
    || !isUuid(row.contactId) || !isUuid(row.skillId) || !isUuid(row.versionId) || !(row.methodId === null || isUuid(row.methodId))
    || !Number.isSafeInteger(row.scopeRevision) || (row.scopeRevision as number) < 0) throw new Error('方法反馈目标无效。');
  return { contactId: row.contactId.toLowerCase(), scopeRevision: row.scopeRevision as number,
    skillId: row.skillId.toLowerCase(), versionId: row.versionId.toLowerCase(), methodId: row.methodId === null ? null : row.methodId.toLowerCase(),
    policyScope: readPolicyScope(row.policyScope, row.contactId.toLowerCase()) };
}
function undoPolicySelection(args: unknown[]) {
  const row = args[0];
  if (args.length !== 1 || !exactObject(row, ['contactId', 'scopeRevision', 'policyId']) || !isUuid(row.contactId)
    || !isUuid(row.policyId) || !Number.isSafeInteger(row.scopeRevision) || (row.scopeRevision as number) < 0) throw new Error('撤销停用目标无效。');
  return { contactId: row.contactId.toLowerCase(), scopeRevision: row.scopeRevision as number, policyId: row.policyId.toLowerCase() };
}
export function installSkillLearningBridge(commands: PageCommands, backend: BackendHost, contacts: ContactSession) {
  const controller = new SkillLearningController(backend, contacts);
  controller.onStateChanged((state) => commands.publish('skill-learning:state-changed', state, 'manager'));
  commands.handle('skill-learning:get-state', (...args) => { noArguments(args); return controller.getState(); }, 'manager');
  commands.handle('skill-learning:refresh', (...args) => controller.refresh(selection(args)), 'manager');
  commands.handle('skill-learning:poll', (...args) => controller.poll(selection(args)), 'manager');
  commands.handle('skill-learning:configure', (...args) => controller.configure(selection(args, true)), 'manager');
  commands.handle('skill-learning:resume', (...args) => controller.resume(selection(args)), 'manager');
  commands.handle('skill-learning:open-review', (...args) => controller.openReview(reviewSelection(args, 'open')), 'manager');
  commands.handle('skill-learning:update-review', (...args) => controller.updateReview(reviewSelection(args, 'update')), 'manager');
  commands.handle('skill-learning:save-review', (...args) => controller.saveReview(reviewSelection(args, 'save')), 'manager');
  commands.handle('skill-learning:compare-review', (...args) => controller.compareReview(reviewSelection(args, 'compare')), 'manager');
  commands.handle('skill-learning:approve-review', (...args) => controller.approveReview(reviewSelection(args, 'approve')), 'manager');
  commands.handle('skill-learning:decide-review', (...args) => controller.decideReview(reviewSelection(args, 'decision')), 'manager');
  commands.handle('skill-learning:retry-review', (...args) => controller.retryReview(reviewSelection(args, 'save')), 'manager');
  commands.handle('skill-learning:close-review', (...args) => controller.closeReview(selection(args)), 'manager');
  commands.handle('skill-learning:open-history', (...args) => controller.openHistory(selection(args)), 'manager');
  commands.handle('skill-learning:close-history', (...args) => controller.closeHistory(selection(args)), 'manager');
  commands.handle('skill-learning:rollback-history', (...args) => controller.rollbackHistory(rollbackSelection(args)), 'manager');
  commands.handle('skill-learning:retry-history', (...args) => controller.retryHistory(selection(args)), 'manager');
  commands.handle('skill-learning:open-policies', (...args) => controller.openPolicies(selection(args)), 'manager');
  commands.handle('skill-learning:close-policies', (...args) => controller.closePolicies(selection(args)), 'manager');
  commands.handle('skill-learning:change-policy', (...args) => controller.changePolicy(policySelection(args)), 'manager');
  commands.handle('skill-learning:undo-policy', (...args) => controller.undoPolicy(undoPolicySelection(args)), 'manager');
  commands.handle('skill-learning:retry-policy', (...args) => controller.retryPolicy(selection(args)), 'manager');
  return controller;
}
