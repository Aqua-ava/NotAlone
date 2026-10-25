/** 具名driver路由；完整材料适配资格与实际逐例覆盖分别报告。 */
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {sha} from '../nonreply-persistent-broker/attempt-journal.mjs';
import {createTasklessBusiness,supportsTaskless} from './taskless-business.mjs';
import {createEmptyLayeredBusiness,supportsEmptyLayered} from './empty-layered-business.mjs';

export function materialCoverage(plan){
  const cases=[...new Map(plan.runs.map(r=>[r.domain+':'+r.case_id,r])).values()];
  return cases.map(run=>({domain:run.domain,case_id:run.case_id,case_sha256:run.case_sha256,
    adapter:supportsTaskless(run)?'skill_public_taskless':supportsEmptyLayered(run)?'layered_public_empty_terminal':
      {memory_extraction:'extractionBusiness',l2_scenario:'createL2ScenarioBusiness',l3_profile:'createL3ProfileBusiness',skill_learning:'createSkillBusiness'}[run.domain],
    material_mapping:'implemented_fields_unverified_until_execution',semantics:'not_independently_reviewed',full_case_runtime_verified:false,
    known_risks:run.case_id==='skill_learning-09'?['frozen_skill_assertCurrent_rejects_foreign_source_rows_before_send']:
      run.case_id==='skill_learning-10'?['wrong_subject_model_semantics_not_verified']:[],
  }));
}
export async function createNamedRouter({snapshot,directory,contexts=new Map(),receipts=[],evaluationClock={mode:'wall',qualification:'engineering_only'},modes=new Map(),onOpen}){
  const load=path=>import(pathToFileURL(join(snapshot.candidate,'.scratch/dsh-ts-migration',path)));
  const [{extractionBusiness},{createL2ScenarioBusiness,createL3ProfileBusiness},{createSkillBusiness}]=await Promise.all([
    load('nonreply-formal-model-seam/extraction-business.mjs'),load('nonreply-layered-formal-drivers/business.mjs'),load('nonreply-skill-formal-driver/skill-business.mjs')]);
  const options={snapshot,directory,contexts,receipts,evaluationClock};
  const business={async open(run){
    const evidenceDirectory=join(directory,sha(run.run_id).slice(0,20));await mkdir(evidenceDirectory,{mode:0o700});
    let adapter;
    if(supportsTaskless(run))adapter=createTasklessBusiness({...options,directory:evidenceDirectory});
    else if(supportsEmptyLayered(run))adapter=createEmptyLayeredBusiness({...options,directory:evidenceDirectory});
    else if(run.domain==='memory_extraction')adapter=extractionBusiness({snapshotRoot:snapshot.directory,directory:evidenceDirectory,contexts,receipts});
    else if(run.domain==='l2_scenario'||run.domain==='l3_profile')adapter=(run.domain==='l2_scenario'?createL2ScenarioBusiness:createL3ProfileBusiness)({...options,directory:evidenceDirectory});
    else if(run.domain==='skill_learning')adapter=createSkillBusiness({snapshotRoot:snapshot.directory,directory:evidenceDirectory,contexts,receipts,modes});
    else throw Error('named_domain_adapter_missing');
    const session=await adapter.open(run);try{await onOpen?.({run,session,context:contexts.get(run.run_id)});return session;}catch(error){await session.close();throw error;}
  }};
  return {business,tasklessEvidence:{async verify({run}){const context=contexts.get(run.run_id);assert.equal(typeof context?.verify,'function','zero_call_actual_observer_missing');return context.verify();}},contexts,receipts};
}
