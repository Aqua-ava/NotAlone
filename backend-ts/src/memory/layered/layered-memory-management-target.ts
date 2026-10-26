/** 原覆盖任务的冻结目标与已提交批次选择；不改变模型算法、单批额度或续轮授权。 */
import {
  L2ScenarioError,canonicalScenarioJSON,scenarioDigest,
  type L2ScenarioMemory,type L2ScenarioVersion,type L2ScenarioBudget,
} from './l2-scenario-workspace.ts';

type Row=Record<string,any>;
function manifest(memory:L2ScenarioMemory):Row {
  return {...memory.dependency_manifest,organization_timing_sha256:scenarioDigest(memory.timing)};
}
function stale():never{throw new L2ScenarioError('l2_scenario_source_changed');}

export function managementTargetInputs(job:Row,available:readonly L2ScenarioMemory[]):L2ScenarioMemory[]{
  // 迁移兼容：旧私有执行适配仍允许不携带公开管理目标；新公开管理必须精确冻结原清单。
  if(!String(job.contract).split(':').includes('typescript-management-v1'))return [...available];
  if(!Array.isArray(job.target_manifest))stale();
  const byId=new Map(available.map(memory=>[memory.memory_id,memory]));
  const selected:L2ScenarioMemory[]=[];
  const seen=new Set<string>();
  for(const item of job.target_manifest){
    const memory=byId.get(item.memory_id);
    if(!memory||seen.has(memory.memory_id)||canonicalScenarioJSON(manifest(memory))!==canonicalScenarioJSON(item))stale();
    seen.add(memory.memory_id);selected.push(memory);
  }
  return selected;
}

export function selectManagementBatch(job:Row,available:readonly L2ScenarioMemory[],current:readonly L2ScenarioVersion[],
  succeeded:readonly Row[],budget:L2ScenarioBudget):L2ScenarioMemory[]{
  const target=managementTargetInputs(job,available);
  const actual=new Map(available.map(memory=>[memory.memory_id,canonicalScenarioJSON(manifest(memory))]));
  const covered=new Set<string>();
  for(const batch of succeeded){
    const inputs=batch.input_manifest;
    if(Array.isArray(inputs)&&inputs.every(item=>actual.get(item.memory_id)===canonicalScenarioJSON(item)))
      for(const item of inputs)covered.add(item.memory_id);
  }
  const selected=target.filter(memory=>!covered.has(memory.memory_id)).slice(0,
    Math.min(budget.max_memories,budget.max_batch_memories));
  if(!selected.length)return selected;
  const byId=new Map(target.map(memory=>[memory.memory_id,memory])),ids=new Set(selected.map(memory=>memory.memory_id));
  // 读取旧主题要带回它实际参与的完整输入，不能只凭直接引用省略隐含来源。
  for(const document of current){
    if(document.input_manifest.some(item=>typeof item.memory_id!=='string'||actual.get(item.memory_id)!==canonicalScenarioJSON(item)))stale();
    for(const item of document.input_manifest){
      if(typeof item.memory_id!=='string')stale();
      const memory=byId.get(item.memory_id);
      if(!memory)stale();
      if(!ids.has(memory.memory_id)){selected.push(memory);ids.add(memory.memory_id);}
    }
    if(selected.length>budget.max_memories)throw new L2ScenarioError('l2_scenario_input_budget_exceeded');
  }
  return selected;
}
