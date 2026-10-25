import test from 'node:test';
import assert from 'node:assert/strict';
import {loadFrozenMaterials,createPlan} from '../resumed-nonreply-evaluation/runner.mjs';
import {adaptMaterial} from './material-adapter.mjs';
test('冻结错误主体、修正、删除及空投影保持可追溯身份与原说话人',async()=>{
  const plan=createPlan(await loadFrozenMaterials(),{newCommit:'4f89bb976dd4086a02b7ae983fee2760d6e4ff64'});
  const find=id=>plan.runs.find(r=>r.case_id===id);
  const wrong=adaptMaterial(find('skill_learning-10'));
  assert.equal(wrong.sources[0].speaker,'contact');assert.equal(wrong.sources[0].user_feedback,false);
  assert.equal(wrong.as_of,'2026-10-23T04:00:00.000Z');
  assert.equal(wrong.existing_skill.version,1);assert.equal(wrong.existing_projection,null);
  const corrected=adaptMaterial(find('l2_scenario-12'));
  assert.equal(corrected.sources[1].speaker,'user');
  assert.equal(corrected.sources[2].corrects_source_ids.length,2);
  assert.equal(corrected.sources[0].version,1);assert.equal(corrected.sources[2].version,1);
  const deleted=plan.runs.find(r=>r.domain==='l3_profile'&&r.material.coverage.source_state==='deleted');
  const mapped=adaptMaterial(deleted);assert.equal(mapped.sources.filter(s=>s.outbound_allowed).length,0);
  assert.equal(plan.runs.length,1056);
});
