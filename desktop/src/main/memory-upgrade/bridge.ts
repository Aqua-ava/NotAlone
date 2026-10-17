import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import { noArguments, type PageCommands } from '../page-commands';
import { isUuid } from '../uuid';
import type { UpgradeSelection, UpgradeOperation, UpgradeBudget } from '../../shared/memory-upgrade-bridge';
import { MemoryUpgradeController } from './controller';

function request(args:unknown[], extra:string[]=[]){
  const row=args[0] as Record<string,unknown>,keys=['kind','contactId','scopeRevision',...extra];
  if(args.length!==1||!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).length!==keys.length||!Object.keys(row).every(key=>keys.includes(key))
    ||!['contact','owner'].includes(row.kind as string)||row.kind==='owner'&&row.contactId!==null||row.kind==='contact'&&!isUuid(row.contactId)
    ||!Number.isSafeInteger(row.scopeRevision)||(row.scopeRevision as number)<0)throw new Error('升级操作无效。');
  return row as unknown as UpgradeSelection;
}
function prepareRequest(args: unknown[]) {
  const row = request(args, ['budget', 'confirmed']) as UpgradeSelection & { budget: UpgradeBudget; confirmed: true };
  const budget = row.budget;
  if (row.confirmed !== true || !budget || typeof budget !== 'object' || Array.isArray(budget)
    || Object.keys(budget).length !== 3 || !Object.keys(budget).every(key => ['message_limit', 'batch_size', 'model_calls'].includes(key))
    || ![[budget.message_limit, 200], [budget.batch_size, 20], [budget.model_calls, 40]].every(([amount, max]) => Number.isSafeInteger(amount) && amount > 0 && amount <= max)) {
    throw new Error('升级预算无效。');
  }
  return row;
}
function operationRequest(args: unknown[]) {
  const row = request(args, ['jobId', 'action', 'expectedRevision', 'confirmed', 'batches']) as UpgradeOperation;
  if (!isUuid(row.jobId) || !['apply', 'undo', 'cancel', 'resume', 'delete'].includes(row.action)
    || row.confirmed !== true || !Number.isSafeInteger(row.expectedRevision) || row.expectedRevision < 1
    || !Array.isArray(row.batches) || row.batches.length > 200
    || !row.batches.every(batch => batch && typeof batch === 'object' && !Array.isArray(batch)
      && Object.keys(batch).length === 2 && Object.keys(batch).every(key => ['batch_id', 'expected_revision'].includes(key))
      && isUuid(batch.batch_id) && Number.isSafeInteger(batch.expected_revision) && batch.expected_revision > 0)) {
    throw new Error('升级批准无效。');
  }
  return row;
}
export function installMemoryUpgradeBridge(commands:PageCommands,backend:BackendHost,contacts:ContactSession){
  const controller=new MemoryUpgradeController(backend,contacts);
  controller.onStateChanged(state=>commands.publish('memory-upgrade:state-changed',state,'manager'));
  commands.handle('memory-upgrade:get-state',(...args)=>{noArguments(args);return controller.getState();},'manager');
  commands.handle('memory-upgrade:select-scope',(...args)=>{if(args.length!==1||!['contact','owner'].includes(args[0] as string))throw new Error('升级范围无效。');controller.selectScope(args[0] as 'contact'|'owner');},'manager');
  commands.handle('memory-upgrade:refresh',(...args)=>controller.refresh(request(args)),'manager');
  commands.handle('memory-upgrade:prepare',(...args)=>controller.prepare(prepareRequest(args)),'manager');
  commands.handle('memory-upgrade:operate',(...args)=>controller.operate(operationRequest(args)),'manager');
  return controller;
}
