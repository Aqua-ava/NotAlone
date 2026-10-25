/** 只在仓库外生成中性可见包和独立私有绑定；本模块不评分。 */
import assert from 'node:assert/strict';
import {randomUUID,randomInt} from 'node:crypto';
import {mkdir,writeFile,chmod} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {ROOT,sha,canonicalDestination} from './runner.mjs';

function shuffle(values){
  const result=[...values];
  for(let i=result.length-1;i>0;i--){const j=randomInt(i+1);[result[i],result[j]]=[result[j],result[i]];}
  return result;
}

export async function writeBlindPackets({plan,observations,privateDirectory}){
  const directory=await canonicalDestination(privateDirectory),root=await canonicalDestination(ROOT);
  assert.ok(directory!==root&&!directory.startsWith(root+'/'),'blind_outputs_must_be_outside_repository');
  await mkdir(directory,{recursive:true,mode:0o700});await chmod(directory,0o700);
  const runs=new Map(plan.runs.map(r=>[r.run_id,r])),seen=new Set(),binding=[],visible=[],excluded=[];
  for(const record of observations){
    const run=runs.get(record.run_id);
    assert.ok(run&&!seen.has(record.run_id),'blind_unplanned_or_duplicate_record');seen.add(record.run_id);
    assert.equal(record.case_sha256,run.case_sha256,'blind_case_binding_mismatch');
    assert.equal(record.provider_kind,'loopback_fake','offline_blind_provider_required');
    if(record.terminal_status!=='succeeded'||record.projection_status!=='captured'||!record.business_output){
      excluded.push({run_id:record.run_id,reason:'no_complete_persisted_projection'});continue;
    }
    const blindId=randomUUID(),projection=structuredClone(record.business_output);
    const outputHash=sha(projection);
    binding.push({blind_id:blindId,run_id:record.run_id,case_id:record.case_id,repeat:record.repeat,
      arm:record.arm,commit:record.commit,output_sha256:outputHash,case_sha256:record.case_sha256});
    visible.push({blind_id:blindId,case_id:record.case_id,domain:record.domain,case_sha256:record.case_sha256,
      input:structuredClone(run.material),output:projection,output_sha256:outputHash});
  }
  const requirements={reviewer_type:'Agent_or_human_must_be_explicit',reviewer_model_version_required:true,
    independent_reviewers:2,third_reviewer_on_disagreement:true,semantic_scoring:'manual_independent_review_only',
    factual_subject_time_negation_conditions_quantity_and_sources:true,
    no_regex_or_pattern_quality_grading:true,review_output_hash_must_match:true,
    coverage_limit:'仅评持久业务投影；完整提取及核验trace需另做中性规范化后补齐，不能据此签完整提取质量。'};
  const packetHashes={};
  for(const reviewer of ['reviewer-a','reviewer-b']){
    const path=join(directory,reviewer);await mkdir(path,{mode:0o700});
    const packet={schema_version:'nonreply-visible-blind-packet-v1',protocol_version:plan.protocol_version,
      material_hash:plan.material_hash,synthetic_only:true,review_requirements:requirements,records:shuffle(visible)};
    const bytes=JSON.stringify(packet,null,2)+'\n';
    await writeFile(join(path,'packet.json'),bytes,{flag:'wx',mode:0o600});packetHashes[reviewer]=sha(bytes);
  }
  const privateBinding={schema_version:'nonreply-private-binding-v1',plan_hash:sha(plan),records:binding,excluded,
    reviewer_access_must_exclude_this_file:true,filesystem_sandbox_provided:false};
  await writeFile(join(directory,'private-binding.json'),JSON.stringify(privateBinding,null,2)+'\n',{flag:'wx',mode:0o600});
  const pairs=new Map();for(const item of binding){const key=`${item.case_id}:${item.repeat}`;if(!pairs.has(key))pairs.set(key,new Set());pairs.get(key).add(item.arm);}
  return {schema_version:'nonreply-blind-receipt-v1',review_status:'not_reviewed',
    eligible_records:visible.length,excluded_records:excluded.length,
    complete_pairs:[...pairs.values()].filter(arms=>arms.size===2).length,
    planned_records:plan.runs.length,independent_reviews_completed:0,packet_hashes:packetHashes,
    real_model_quality_verified:false,production_switch_approved:false};
}
