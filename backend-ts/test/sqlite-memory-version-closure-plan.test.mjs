import test from 'node:test';
import assert from 'node:assert/strict';
import {adjudicationFixture,adjudicationSupplier,owner} from './fixtures/memory-management/adjudication-support.mjs';

/**
 * 回归：开发实例中 memoryAdjudication.finish 超过 15 秒被判 action_timeout。
 * 根因是版本闭包递归 CTE 的递归步先扫 memory_version、后与递归队列 a 相连，
 * 相关子查询又从 execution_input 按 owner_id 全表扫描，每个（版本，输入）组合都扫一遍。
 * 这里在含 auto 更新链的真实数据上检查两条生产语句的执行计划，固定其访问形状。
 */
test('版本闭包递归查询由递归队列驱动，且按 event_id 定位执行输入而不全表扫描',async t=>{
 const f=await adjudicationFixture(t);
 await f.extract(['我长期住在高雄。'],{publish:true});
 f.setRespond(adjudicationSupplier({action:'update'}));
 await f.extract(['我现在长期住在台南。'],{publish:true});
 const memory=(await f.read()).memories[0];assert.equal(memory.current.versionNo,'2');
 const plans=await f.storage.execute('fixture.versionClosurePlans',{ownerId:owner,memoryId:memory.id,versionNo:'2'});
 assert.equal(plans.length,2,'应捕获 evidence 与 dependencies 两条版本闭包语句');
 for(const plan of plans){
  const inputs=plan.filter(detail=>/\bx USING\b/.test(detail));
  assert.ok(inputs.length>0,`计划应包含 execution_input 访问：\n${plan.join('\n')}`);
  for(const detail of inputs)assert.match(detail,/event_id=\?/,`execution_input 不得只按 owner_id 扫描：${detail}`);
  const decision=plan.findIndex(detail=>/^SEARCH d USING INDEX sqlite_autoindex_memory_decision_1/.test(detail));
  assert.ok(decision>=2,`计划应包含递归步的 memory_decision 访问：\n${plan.join('\n')}`);
  assert.equal(plan[decision-2],'SCAN a',`递归步应先取递归队列：\n${plan.join('\n')}`);
  assert.match(plan[decision-1],/^SEARCH v USING INDEX sqlite_autoindex_memory_version_1 \(owner_id=\? AND memory_id=\? AND version_no=\?\)/);
 }
});
