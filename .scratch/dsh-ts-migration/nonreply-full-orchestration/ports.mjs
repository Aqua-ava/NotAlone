/** 根统一集成时的实际接线工厂；不创建额度，不解析凭据，不提供默认外发。 */
import assert from 'node:assert/strict';
import {createNamedRouter} from './router.mjs';
export {FullOrchestrator,reportFor} from './orchestrator.mjs';
export {prepareFormalPlan} from '../nonreply-formal-model-seam/plan.mjs';
export {bindExistingProblemBudget} from '../nonreply-formal-model-seam/problem-budget-port.mjs';
export {createUnifiedSnapshot} from './snapshot.mjs';
export {exportBlind} from './blind.mjs';
export async function createRootPorts({plan,snapshot,directory,budget,permission,transport,evaluationClock,contexts,receipts,
  observationContext,blindProjector,onOpen,onResult,recoverStaleLock}){
  assert.equal(snapshot.source.candidate_commit,plan.new_commit,'root_final_candidate_archive_changed');
  assert.equal(budget?.persistent,true,'root_existing_problem_budget_required');
  assert.equal(typeof permission?.assertAllowed,'function','root_permission_required');
  assert.ok(transport&&typeof transport.prepare==='function','root_explicit_transport_required');
  const router=await createNamedRouter({snapshot,directory,contexts,receipts,evaluationClock,onOpen});
  return {...router,source:{assertCurrent:()=>snapshot.assertCurrent()},budget,permission,transport,observationContext,blindProjector,onResult,recoverStaleLock,
    controls:{model:'deepseek-flash',maxTokens:393216,temperature:0,thinking:'disabled'}};
}
