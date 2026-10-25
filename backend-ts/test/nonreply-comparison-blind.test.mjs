/** 可见盲包与私有绑定的公开接缝；不执行评分或模型。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadFrozenMaterials,createPlan,runPlan,ROOT} from '../../.scratch/dsh-ts-migration/resumed-nonreply-evaluation/runner.mjs';
import {writeBlindPackets} from '../../.scratch/dsh-ts-migration/resumed-nonreply-evaluation/blind.mjs';

test('两份独立评阅可见包不泄露arm、commit、顺序或绑定，未评分不能通过',{timeout:10000},async()=>{
  const plan=createPlan(await loadFrozenMaterials(),{newCommit:'263365556e9058b3fc7b1abbbdbe43b7f9a323d2'});
  const selected=plan.runs.filter(r=>r.case_id==='明确事实'&&r.repeat===1).map(r=>r.run_id);
  const observations=await runPlan(plan,{selectedRunIds:selected,execute:async()=>({terminal_status:'succeeded',
    provider_kind:'loopback_fake',physical_calls:1,business_output:{facts:[],scenarios:[],profile_entries:[],skill_drafts:[]},projection_status:'captured'})});
  const directory=await mkdtemp(join(tmpdir(),'notalone-nonreply-blind-'));
  try{
    const receipt=await writeBlindPackets({plan,observations,privateDirectory:directory});
    assert.equal(receipt.review_status,'not_reviewed');
    assert.equal(receipt.eligible_records,2);
    assert.equal(receipt.complete_pairs,1);
    const packet=JSON.parse(await readFile(join(directory,'reviewer-a/packet.json'),'utf8'));
    const binding=JSON.parse(await readFile(join(directory,'private-binding.json'),'utf8'));
    assert.equal(packet.records.length,2);
    const forbidden=new Set(['arm','commit','run_id','order','sequence','provenance']);
    const inspect=value=>{if(value&&typeof value==='object')for(const [key,item]of Object.entries(value)){assert.ok(!forbidden.has(key));inspect(item);}};
    inspect(packet);
    assert.equal(new Set(binding.records.map(r=>r.arm)).size,2);
    assert.equal((await stat(join(directory,'private-binding.json'))).mode&0o777,0o600);
    assert.equal((await stat(join(directory,'reviewer-a'))).mode&0o777,0o700);
    await assert.rejects(writeBlindPackets({plan,observations,privateDirectory:join(ROOT,'.scratch/forbidden-blind')}),/outside_repository/);
  }finally{await rm(directory,{recursive:true,force:true});}
});
