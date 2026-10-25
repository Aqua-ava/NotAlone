/** 仅写私有盲包；全分母状态保留，具体正文投影由根提供具名合同。 */
import assert from 'node:assert/strict';
import {randomBytes,createHmac} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {privateDirectory} from './orchestrator.mjs';
import {sha} from '../nonreply-persistent-broker/attempt-journal.mjs';
export function sourceMaterial(run){
  return run.domain==='memory_extraction'?run.material.messages.map(([speaker,text],i)=>({source_label:'S'+(i+1),speaker,text,state:'active',
    source_time:new Date(Date.UTC(2026,8,15,0,i)).toISOString(),event_time:'unknown'})):
    run.material.input.sources.map((s,i)=>({source_label:'S'+(i+1),speaker:'unknown_unless_literal',text:s.text,state:s.state,subject:s.subject,version:s.version,
      source_time:s.observed_at,event_time:'unknown',scope:s.owner_id===run.material.input.scope.owner_id&&s.contact_id===run.material.input.scope.contact_id?'target':'foreign'}));
}
function projection(value,sources){
  assert.ok(value&&Array.isArray(value.items),'blind_items_required');
  assert.ok(Object.keys(value).every(k=>['items','unobserved','source_mapping_status'].includes(k)),'blind_unverified_projection_field');
  const labels=new Map(sources.map(s=>[s.source_label,s]));
  for(const item of value.items){
    assert.ok(typeof item.text==='string'&&Array.isArray(item.evidence),'blind_item_text_and_evidence_required');
    assert.ok(Object.keys(item).every(k=>['kind','text','subject','conditions','event','timing','evidence','status','claim_fields'].includes(k)),'blind_identity_or_unverified_field');
    for(const evidence of item.evidence){assert.ok(labels.has(evidence.source_label),'blind_source_not_in_frozen_material');assert.equal(typeof evidence.quote,'string','blind_quote_required');
      assert.ok(labels.get(evidence.source_label).text.includes(evidence.quote),'blind_quote_not_in_source');assert.deepEqual(Object.keys(evidence).sort(),['quote','source_label'],'blind_evidence_identity_leak');}
  }return value;
}
export async function exportBlind({plan,report,directory,projector}){
  assert.equal(report.plan_sha256,sha(plan),'blind_plan_changed');assert.equal(report.records.length,1056,'blind_full_denominator_required');
  assert.equal(typeof projector?.project,'function','root_neutral_blind_projector_required');assert.match(projector.contract_sha256??'',/^[a-f0-9]{64}$/,'blind_projection_source_binding_required');
  await privateDirectory(dirname(directory));await mkdir(directory,{mode:0o700});await privateDirectory(directory);
  const seed=randomBytes(32),hmac=value=>createHmac('sha256',seed).update(value).digest('hex');
  const byId=new Map(report.records.map(r=>[r.run_id,r])),bindings=[],packets=[];
  for(let i=0;i<plan.runs.length;i+=2){
    const runs=plan.runs.slice(i,i+2),sources=sourceMaterial(runs[0]),key=hmac('pair:'+runs[0].run_id).slice(0,24),outputs=[];
    for(const run of runs){const record=byId.get(run.run_id);assert.ok(record,'blind_record_missing');
      const value=projection(await projector.project({run,record,sources}),sources),blindId=hmac('output:'+run.run_id).slice(0,24);
      outputs.push({blind_id:blindId,terminal_status:record.terminal_status,projection:value});bindings.push({blind_id:blindId,run_id:run.run_id,pair_id:key});}
    outputs.sort((a,b)=>a.blind_id.localeCompare(b.blind_id));
    packets.push({pair_id:key,domain:runs[0].domain,sources,outputs});
  }
  const receipts=[];
  for(const reviewer of ['reviewer-a','reviewer-b']){
    const path=join(directory,reviewer);await mkdir(path,{mode:0o700});
    const rows=packets.map(packet=>({...packet,outputs:[...packet.outputs].sort((a,b)=>hmac(reviewer+a.blind_id).localeCompare(hmac(reviewer+b.blind_id)))}))
      .sort((a,b)=>hmac(reviewer+a.pair_id).localeCompare(hmac(reviewer+b.pair_id)));
    const bytes=rows.map(row=>JSON.stringify(row)).join('\n')+'\n';await writeFile(join(path,'packets.jsonl'),bytes,{mode:0o600,flag:'wx'});receipts.push({reviewer,pairs:rows.length,outputs:rows.length*2,sha256:sha(bytes)});
  }
  await writeFile(join(directory,'private-binding.json'),JSON.stringify({seed:seed.toString('hex'),bindings,plan_sha256:sha(plan),report_sha256:sha(report),projection_contract_sha256:projector.contract_sha256}),{mode:0o600,flag:'wx'});
  return {schema_version:'full-nonreply-blind-receipt-v1',population:report.population,reviewer_packets:receipts,projection_contract_sha256:projector.contract_sha256,
    meaningful_outputs:packets.flatMap(p=>p.outputs).filter(o=>o.projection.items.length>0).length,semantic_review_completed:false,quality_approved:false};
}
