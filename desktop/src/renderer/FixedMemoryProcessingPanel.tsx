import { useEffect, useRef, useState } from 'react';
import type { FixedMemoryProcessingBridge, FixedProcessingRun, FixedProcessingView, FixedProcessingQueue } from '../shared/fixed-memory-processing';
import { useAutomaticProcessing } from './MemoryAutomaticSwitch';

const sharedReasons: Record<string, string> = {
  extraction_model_unconfigured: '模型尚未配置',
  extraction_model_configuration_invalid: '模型配置无效',
  extraction_model_credentials_unavailable: '模型凭据不可用',
  extraction_model_authentication_failed: '模型认证失败',
  extraction_model_provider_unavailable: '模型服务暂不可用',
  extraction_model_scope_invalid: '模型用途范围不可用',
  memory_extraction_model_configuration_invalid: '模型配置无效',
  document_model_unconfigured: '模型尚未配置',
  document_model_configuration_invalid: '模型配置无效',
  document_model_credentials_unavailable: '模型凭据不可用',
  document_model_scope_invalid: '模型用途范围不可用',
};
const blockedReasons: Record<string, string> = {
  extraction_model_image_unsupported:'当前模型不支持图片，本批图片仍待处理。请配置支持图片的模型后继续。',
  extraction_model_image_invalid:'图片内容暂时无法送入模型，本批保留待处理。',
  extraction_model_image_budget_exceeded:'图片超出本次处理上限，本批保留待处理。',
  memory_content_plugin_unavailable:'这类内容的处理插件尚未就绪，本批保留待处理。',
  memory_content_source_stale:'本批使用的图片或其他内容已变化，需要按当前有效资料重新处理。',
  extraction_model_validation_failed: '模型返回未通过格式校验，待处理消息和已完成进度会保留。',
  history_source_not_available: '聊天来源暂不可用，需要重新核验；待处理消息和已完成进度会保留。',
  memory_extraction_interrupted: '上次处理被应用退出中断，已保留进度，等待安全续跑。',
  extraction_policy_source_unavailable: '应用已更新，旧任务需要按当前版本恢复；点击恢复本轮处理继续未完成内容。',
  extraction_runtime_config_invalid: '旧任务的提取配置无法读取，请检查配置后再恢复。',
  model_receipt_unknown: '调用结果待核实',
  interrupted_known_receipts: '上次处理已中断，已完成的进度已保留',
  run_revoked: '范围已失效',
  scope_revoked: '范围已失效',
  later_stages_pending: '提取核验已结束',
  later_stages_failed: '主题整理或长期概览阶段受阻',
  owner_contribution_pending: '本人资料阶段因范围变化未提交，需要新一轮处理',
  contact_failed: '当前联系人处理受阻',
  round_failed: '本轮处理受阻',
  round_incomplete: '本轮尚未完成',
  no_pending_inputs: '当前没有待处理的文字目标',
  memory_extraction_source_insufficient: '提取结果未通过来源核验，本轮尚未完成。',
  memory_extraction_failed: '本轮记忆提取失败，请查看处理原因。',
};
/** 固定原因码由后端给出；界面只做固定文案映射，不把历史失败或数量换算成完成。 */
function reasonText(reason: string | null): string {
  if (!reason) return '处理暂时受阻';
  if (blockedReasons[reason]) return blockedReasons[reason];
  if (sharedReasons[reason]) return `模型配置或服务不可用：${sharedReasons[reason]}。`;
  return '处理暂时受阻';
}
function stageText(run: FixedProcessingRun): string {
  if (run.stage === 'document_scene') return '正在整理主题资料';
  if (run.stage === 'document_profile') return '正在整理长期概览';
  if (run.stage !== 'extraction_verification') return '正在处理后续阶段';
  return '正在提取与核验';
}
function statusText(run: FixedProcessingRun | null, queue?: FixedProcessingQueue): string {
  if (!run) return '等待处理';
  if (run.status === 'paused') return '已暂停';
  if (run.status === 'blocked') return '处理受阻';
  if (run.status === 'completed') {
    if(queue?.pending)return '等待提取与核验';
    if(queue?.later?.pending)return queue.later.stage==='document_profile'?'等待更新长期概览':queue.later.stage==='document_scene'?'等待整理主题资料':'后续阶段待处理';
    return '本轮已完成';
  }
  if (run.status === 'processing') return stageText(run);
  if (run.statusReason === 'later_stages_scheduled') return run.stage === 'document_profile' ? '等待更新长期概览' : '等待整理主题资料';
  return run.total === 0 ? '当前没有待处理的文字目标' : '等待提取与核验';
}

/** 只使用后端发布的恢复资格；回执后重新读取，不把接纳当作已完成。 */
function RecoveryControl({bridge,view,onSettled}:{bridge:FixedMemoryProcessingBridge;view:FixedProcessingView;onSettled:()=>Promise<void>}) {
  const [pending,setPending]=useState(false),[error,setError]=useState('');
  const busy=useRef(false),alive=useRef(true),attempt=useRef<{version:number;id:string}|null>(null);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const run=view.run;
  if(!run || !run.actions.includes('continue') || !['blocked','paused'].includes(run.status))return null;
  const recover=async()=>{
    if(busy.current)return;
    busy.current=true;setPending(true);setError('');
    if(attempt.current?.version!==run.controlVersion)attempt.current={version:run.controlVersion,id:crypto.randomUUID()};
    try{
      await bridge.continue({runId:run.runId,controlVersion:run.controlVersion,operationId:attempt.current.id,connectionGeneration:view.connectionGeneration});
      if(alive.current)attempt.current=null;
    }catch{if(alive.current)setError('恢复结果暂未确认，请核对最新状态后重试。');}
    finally{
      if(alive.current){await onSettled();if(alive.current){busy.current=false;setPending(false);}}
    }
  };
  return <div className="memory-processing-actions">
    <button className="button primary" type="button" disabled={pending} onClick={()=>void recover()}>{pending?'正在恢复…':'恢复本轮处理'}</button>
    <p className="memory-section-note">恢复本轮提取与相关本人资料整理；已完成内容会跳过。</p>
    {error&&<p role="alert">{error}</p>}
  </div>;
}

/** 由记忆页面传入具名桥；scopeKey变化或失效事件先撤下全部本地快照。 */
export function FixedMemoryProcessingPanel({ bridge, contactId, scopeKey = '', onRunUpdated, visible = true, releaseOnUnmount = true }: { bridge: FixedMemoryProcessingBridge; contactId: string | null; scopeKey?: string | number; onRunUpdated?:(run:FixedProcessingRun|null)=>void; visible?:boolean; releaseOnUnmount?:boolean }) {
  const [snapshot, setSnapshot] = useState<{ bridge: FixedMemoryProcessingBridge; contactId: string; scopeKey: string | number; view: FixedProcessingView } | null>(null);
  const [error, setError] = useState('');
  const automatic = useAutomaticProcessing(bridge);
  const refresh=useRef<()=>Promise<void>>(async()=>{});
  const pageVisible = useRef(visible);
  pageVisible.current = visible;
  const visibilityChanged = useRef<()=>void>(()=>{});
  useEffect(()=>{ visibilityChanged.current(); },[visible]);
  const updated = useRef(onRunUpdated);
  updated.current = onRunUpdated;
  const view = snapshot?.bridge === bridge && snapshot.contactId === contactId && snapshot.scopeKey === scopeKey ? snapshot.view : null;
  useEffect(() => () => { if(releaseOnUnmount)void bridge.release().catch(() => {}); }, [bridge,releaseOnUnmount]);
  useEffect(() => {
    let active = true, revision = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setSnapshot(null); setError('');
    updated.current?.(null);
    if (!contactId) return;
    const schedule = (delay: number) => {
      clearTimeout(timer);
      if (active && pageVisible.current && !document.hidden) timer = setTimeout(() => void read(), delay);
    };
    const read = async () => {
      clearTimeout(timer);
      const accepted = ++revision;
      try {
        const next = await bridge.readCurrent({contactId});
        if (!active || accepted !== revision) return;
        if (next.contactId !== contactId) throw new Error('记忆处理范围不一致');
        setSnapshot({ bridge, contactId, scopeKey, view: next }); setError('');
        updated.current?.(next.run);
        schedule(next.run?.status === 'processing' ? 2000 : 10000);
      } catch {
        if (!active || accepted !== revision) return;
        setSnapshot(null); setError('处理状态暂不可用，正在自动重试。');
        schedule(10000);
      }
    };
    refresh.current=read;
    const unsubscribe = bridge.onInvalidated(() => {
      revision++; setSnapshot(null);
      setError('资料资格或连接已变化，正在重新核对处理状态。');
      schedule(2000);
    });
    const updateVisibility = () => {
      if (document.hidden || !pageVisible.current) clearTimeout(timer);
      else void read();
    };
    visibilityChanged.current=updateVisibility;
    document.addEventListener('visibilitychange', updateVisibility);
    void read();
    return () => {
      active = false; revision++; clearTimeout(timer); unsubscribe();
      visibilityChanged.current=()=>{};
      document.removeEventListener('visibilitychange', updateVisibility);
    };
  }, [bridge, contactId, scopeKey]);
  const run = view?.run ?? null;
  const allTargetsDone = run && run.total > 0 && run.succeeded === run.total && run.pending === 0;
  const noNewMemory = allTargetsDone && run.candidates.length === 0
    && run.tasks.length > 0 && run.tasks.every(task => ['succeeded', 'awaiting_decision'].includes(task.state));
  const failureReason = run && ['contact_failed','round_failed'].includes(run.statusReason ?? '')
    ? run.tasks.find(task => task.state === 'failed' && task.errorCode)?.errorCode ?? run.statusReason : run?.statusReason ?? null;
  return <section className="memory-processing-card fixed-memory-processing" aria-label="固定范围记忆处理">
    <header className="memory-processing-bar"><h2>记忆处理</h2>
      {view && <p role="status">{statusText(run,view.queue)}</p>}
    </header>
    <p className="memory-section-note">历史与增量分别排队；下方进度只表示最近一批消息的处理情况</p>
    {automatic.enabled === false && <p role="status">记忆自动处理已关闭：新消息只保存，不会提取记忆；在页面顶部开启后才会继续处理。</p>}
    {error && <p role="alert">{error}</p>}
    {!contactId && <p>请先选择联系人，再查看记忆处理状态。</p>}
    {contactId && !view && !error && <p aria-live="polite">正在核对处理状态…</p>}
    {view && !run && <><p>暂无处理记录</p><p>新增消息会先积累，在会话静默或达到批量条件后自动处理；已有历史单独初始化。</p></>}
    {view?.queue?.history && <p>历史待提取消息 {view.queue.history.pending} 条。导入完成后自动分批处理，已完成消息会跳过。</p>}
    {view?.queue && view.queue.pending > 0 && <p>增量待提取消息 {view.queue.pending} 条。{view.queue.nextDueAt != null ? `预计 ${new Date(view.queue.nextDueAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 检查批量条件。` : ''}{view.queue.blockedContacts > 0 ? '当前联系人已暂停或受阻，待处理消息会保留。' : ''}</p>}
    {view?.queue?.content?.filter(item=>item.unavailable>0).map(item=><p key={item.kind}>{item.kind==='image'?'图片':'内容'}尚未就绪 {item.unavailable} 条，未计为已处理。</p>)}
    {view?.queue?.later && view.queue.later.pending > 0 && <p>主题与长期概览仍有 {view.queue.later.pending} 项待处理。{view.queue.later.nextDueAt != null && run?.statusReason !== 'later_stages_scheduled' ? `预计 ${new Date(view.queue.later.nextDueAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 继续。` : ''}</p>}
    {run && <>
      {run.status === 'blocked' && <p>{reasonText(failureReason)}</p>}
      {automatic.enabled !== false && <RecoveryControl key={`${contactId}:${scopeKey}:${view!.connectionGeneration}:${run.runId}`} bridge={bridge} view={view!} onSettled={()=>refresh.current()}/>}
      {run.statusReason === 'later_stages_scheduled' && run.nextDueAt != null && <p>预计 {new Date(run.nextDueAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 开始，执行前会重新核对资料。</p>}
      <p>最近一批提取与核验：已处理 {run.succeeded} / {run.total} 条消息目标</p>
      {run.contentCounts?.map(item=><p key={item.kind}>{item.kind==='text'?'文字':item.kind==='image'?'图片':'其他内容'}：已处理 {item.succeeded} / {item.total} 条</p>)}
      {run.total > 0 && <progress className="memory-processing-progress" aria-label="消息提取与核验进度" max={run.total} value={run.succeeded}/>}
      {run.pending > 0 && <p>待处理 {run.pending} 条消息目标</p>}
      {run.revoked > 0 && <p>有 {run.revoked} 条目标因取消勾选或来源删除失效，不计入待处理。</p>}
      {noNewMemory && <p>已处理，未产生新记忆</p>}
      {run.failed > 0 && <p>有 {run.failed} 条目标尚未通过提取核验。</p>}
      {run.unknown > 0 && <p>有 {run.unknown} 条目标调用结果未知，核实前不会重新发送。</p>}
      {run.sharedFaultCode && run.sharedFaultCode !== run.statusReason && <p>模型配置或服务不可用：{sharedReasons[run.sharedFaultCode] ?? '通用模型故障'}。</p>}
      {run.laterStages==='completed'?<p>主题整理与长期概览已完成。</p>:<p>主题整理、长期概览尚未全部完成。</p>}
    </>}
  </section>;
}
