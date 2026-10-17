import { useEffect, useState } from 'react';
import type { ContactSessionView } from './contact-session';
import type { MemoryUpgradeState, UpgradeJob, UpgradeSelection, UpgradeRecord } from '../shared/memory-upgrade-bridge';
import { useRevisionedSession } from './use-revisioned-session';

const initial:MemoryUpgradeState={revision:-1,kind:'contact',contactId:null,scopeRevision:0,phase:'idle',jobs:[],error:null};
const states:Record<string,string>={queued:'等待比较',ready:'等待批准',apply_queued:'等待应用',applied:'已应用',undone:'已撤销',failed:'失败，可恢复',invalidated:'来源已失效'};
export function MemoryUpgradePage({session}:{session:ContactSessionView}){
  const bridge=window.notalone.memoryUpgrade,{state}=useRevisionedSession(initial,bridge);
  const [limit,setLimit]=useState(40),[batchSize,setBatchSize]=useState(10),[calls,setCalls]=useState(8),[confirmed,setConfirmed]=useState(false);
  const {selectedContactId,scopeRevision}=session.state;
  const selection:UpgradeSelection={kind:state.kind,contactId:state.kind==='owner'?null:selectedContactId,scopeRevision};
  const available=state.kind==='owner'||selectedContactId!==null;
  const current=available&&state.scopeRevision===scopeRevision&&state.contactId===selection.contactId;
  useEffect(()=>{setConfirmed(false);},[state.kind,selectedContactId,scopeRevision]);
  useEffect(()=>{
    if(!available)return;
    const refresh=()=>{void bridge.refresh(selection).catch(()=>{});};refresh();
    const timer=setInterval(refresh,3000);return ()=>clearInterval(timer);
  },[bridge,available,state.kind,selectedContactId,scopeRevision]);
  return <section aria-label="旧资料升级">
    <h2>比较旧资料，再批准升级</h2>
    <p>此操作会按明确预算重新分析所选历史消息。预览不会改写事实；批准后仍遵守来源、人工决定和现有质量门。旧版未知证明保持未知。</p>
    <label>升级范围<select aria-label="升级范围" value={state.kind} onChange={event=>void bridge.selectScope(event.target.value as 'contact'|'owner')}>
      <option value="contact">当前已确认联系人资料</option><option value="owner">独立本人资料</option>
    </select></label>
    {state.kind==='owner'&&<p>只从本人发出的历史消息比较本人资料，按实际联系人来源分批，不将联系人的事实写入本人资料。</p>}
    {!available&&<p>请先选择并确认联系人，或明确选择独立本人资料。</p>}
    <div className="form-grid">
      <label>总消息上限<input aria-label="总消息上限" type="number" min={1} max={200} value={limit} onChange={event=>setLimit(Number(event.target.value))}/></label>
      <label>每批消息上限<input aria-label="每批消息上限" type="number" min={1} max={20} value={batchSize} onChange={event=>setBatchSize(Number(event.target.value))}/></label>
      <label>总模型调用上限<input aria-label="总模型调用上限" type="number" min={1} max={40} value={calls} onChange={event=>setCalls(Number(event.target.value))}/></label>
    </div>
    <p>提取、核验、裁决和重试共用总调用预算。恢复不会追加预算，也不会读取创建工作之后的新消息。</p>
    <label><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>我确认此范围和预算，先生成差异预览</label>
    <div className="button-row">
      <button className="button" disabled={!current||state.phase!=='ready'||!confirmed} onClick={()=>void bridge.prepare({...selection,
        budget:{message_limit:limit,batch_size:batchSize,model_calls:calls},confirmed:true}).catch(()=>{})}>确认范围与预算并比较</button>
      <button className="button" disabled={!available} onClick={()=>void bridge.refresh(selection).catch(()=>{})}>刷新升级进度</button>
    </div>
    {state.error&&<p role="alert">{state.error}</p>}
    {current&&state.jobs.map(job=><UpgradeJobCard key={job.job_id} job={job} selection={selection} disabled={state.phase!=='ready'}/>)}
    {current&&state.phase==='ready'&&state.jobs.length===0&&<p>尚无升级工作。不会自动重跑历史资料。</p>}
  </section>;
}

export function UpgradeJobCard({job,selection,disabled=false}:{job:UpgradeJob;selection:UpgradeSelection;disabled?:boolean}){
  const [selected,setSelected]=useState<Record<string,number>>({});
  const operate=(action:'apply'|'undo'|'cancel'|'resume'|'delete')=>window.notalone.memoryUpgrade.operate({...selection,
    jobId:job.job_id,expectedRevision:job.revision,action,confirmed:true,
    batches:['apply','undo'].includes(action)?job.batches.filter(batch=>selected[batch.batch_id]===batch.revision&&batch.state===(action==='apply'?'ready':'applied'))
      .map(batch=>({batch_id:batch.batch_id,expected_revision:batch.revision})):[]});
  const actionable=(state:string)=>job.batches.some(batch=>batch.state===state&&selected[batch.batch_id]===batch.revision);
  return <article className="memory-card" aria-label="升级工作">
    <h3>升级工作 · {job.state==='active'?'活动':job.state==='cancelled'?'已取消':'已删除'}</h3>
    <p>已扣记模型调用预算 {job.model_calls_used} / {job.budget.model_calls} · 共 {job.batches.length} 批 · 修订 {job.revision}</p>
    {job.algorithm ? <p>比较算法：{job.algorithm.protocol} · 指纹：<code>{job.algorithm.digest}</code></p>
      : <p role="status">旧工作算法身份未知，重新比较后才能应用。旧证明保持未知。</p>}
    {job.batches.length===0&&<p>所选范围内没有可用于比较的历史消息，没有调用模型。</p>}
    {job.batches.map(batch=><section key={batch.batch_id} aria-label={`升级批次 ${batch.number}`}>
      <h4>批次 {batch.number} · {states[batch.state]}</h4><p>消息 {batch.message_count} 条 · 修订 {batch.revision}</p>
      {batch.error_code&&<p role="status">{['algorithm_changed','memory_upgrade_algorithm_changed'].includes(batch.error_code)
        ? '算法或配置已变化，请重新预览；原批准不能复用。'
        : '此批暂未完成，请核对来源和剩余预算后恢复；已完成批次保留。'}</p>}
      {batch.state==='ready'&&(!job.algorithm||!batch.algorithm)&&<p role="status">此批算法身份未知，请创建新的比较后再批准。</p>}
      {['ready','applied'].includes(batch.state)&&<label><input type="checkbox" aria-label={`选择批次 ${batch.number}`} disabled={disabled||job.state!=='active'||batch.state==='ready'&&(!job.algorithm||!batch.algorithm)}
        checked={selected[batch.batch_id]===batch.revision} onChange={event=>setSelected({...selected,[batch.batch_id]:event.target.checked?batch.revision:0})}/>选择此修订的批次</label>}
      {batch.comparison&&<>
        <p>相关旧资料 {batch.comparison.current_count} 条，最多展示 8 条。人工确认、纠正和否决不会被自动覆盖。</p>
        {batch.comparison.current.map(record=><OldRecord key={record.memory_id} record={record}/>)}
        {batch.comparison.actions.map(action=><div key={action.candidate_id}>
          <p><b>{({pending:'预计加入待确认',auto_add:'预计自动采纳新事实',auto_update:'预计自动更新旧事实'})[action.kind]}</b></p>
          {action.previous&&<OldRecord record={action.previous}/>}
          <p>新结果：{action.new.text}</p><p>{action.new.has_new_proof?'本次具有新核验记录，应用仍复验质量门。':'本次没有完整新证明，保持原质量门。'}</p>
          {action.new.correction_review.length>0&&<p>涉及人工决定，需沿原审核入口明确处理。</p>}
          <details><summary>查看本次来源身份</summary>{action.new.source_ids.map(id=><p key={id}>{id}</p>)}</details>
        </div>)}
        {batch.comparison.actions.length===0&&<p>本批没有新增差异，可能重复、被否决保护或不属于所选主体。</p>}
      </>}
    </section>)}
    <div className="button-row">
      <button className="button" disabled={disabled||job.state!=='active'||!job.algorithm||!actionable('ready')} onClick={()=>void operate('apply').catch(()=>{})}>确认应用所选批次</button>
      <button className="button" disabled={disabled||job.state!=='active'||!actionable('applied')} onClick={()=>void operate('undo').catch(()=>{})}>确认撤销所选批次</button>
      <button className="button" disabled={disabled||job.state!=='active'} onClick={()=>void operate('cancel').catch(()=>{})}>取消未完成工作</button>
      <button className="button" disabled={disabled} onClick={()=>void operate('resume').catch(()=>{})}>按剩余预算恢复</button>
      <button className="button" disabled={disabled} onClick={()=>void operate('delete').catch(()=>{})}>删除升级预览与工作副本</button>
    </div>
    <p>撤销只处理本批新建且未被后续修改的资料。删除工作副本不会代替对已应用事实的明确撤销。</p>
  </article>;
}
function OldRecord({record}:{record:UpgradeRecord}){return <blockquote><p>旧资料：{record.text}</p><p>{record.adoption_method==='manual'?'用户明确确认':'自动采纳'} · 修订 {record.revision} · {record.proof_kind==='unknown'?'旧版证明未知':'保留原版本依据'}</p></blockquote>;}
