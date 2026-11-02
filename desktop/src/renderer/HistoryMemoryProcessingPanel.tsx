import {useEffect,useRef,useState} from 'react';
import type {FixedHistoryFailureReason,FixedMemoryProcessingBridge} from '../shared/fixed-memory-processing';

const reasons:Record<FixedHistoryFailureReason,string>={
  no_pending_history:'当前联系人没有待处理的历史文字。',
  busy:'当前联系人已有记忆任务正在处理或等待后续整理，请等待本轮完成。',
  blocked:'当前联系人已有受阻或暂停的记忆任务，请先解决原任务的阻碍。',
  scope_changed:'联系人或处理请求已变化，请重新核对后启动。',
  source_check_busy:'正在同步当前联系人的聊天，请稍后重试处理历史聊天。',
  source_stale:'上次启动未通过联系人或资料来源检查，请到同步设置核对后重试。',
};
type Scope={bridge:FixedMemoryProcessingBridge;contactId:string|null;scopeRevision:number};
type Notice={scope:Scope;phase:'starting'|'started'|'failed';message?:string};

/** 历史初始化是显式单联系人动作；页面读取与分类切换不触发处理。 */
export function HistoryMemoryProcessingPanel({bridge,contactId,scopeRevision,onStarted}:{bridge:FixedMemoryProcessingBridge;contactId:string|null;scopeRevision:number;onStarted:()=>void}){
  const scope=useRef<Scope>({bridge,contactId,scopeRevision}),mounted=useRef(true);
  if(scope.current.bridge!==bridge||scope.current.contactId!==contactId||scope.current.scopeRevision!==scopeRevision)scope.current={bridge,contactId,scopeRevision};
  const accepted=scope.current;
  const [notice,setNotice]=useState<Notice|null>(null);
  const revision=useRef(0),pending=useRef<{scope:Scope;revision:number}|null>(null),request=useRef<{scope:Scope;key:string}|null>(null);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{
    const unsubscribe=bridge.onInvalidated(()=>{
      revision.current++;pending.current=null;setNotice(null);
    });
    return()=>{revision.current++;pending.current=null;unsubscribe();};
  },[bridge]);
  const current=notice?.scope===accepted?notice:null;
  const start=async()=>{
    if(!contactId||pending.current?.scope===accepted)return;
    const operation={scope:accepted,revision:revision.current};
    pending.current=operation;
    if(request.current?.scope!==accepted)request.current={scope:accepted,key:crypto.randomUUID()};
    const requestKey=request.current.key;
    const valid=()=>mounted.current&&scope.current===accepted&&revision.current===operation.revision;
    setNotice({scope:accepted,phase:'starting'});
    try{
      const view=await bridge.readCurrent({contactId});if(!valid())return;
      if(view.contactId!==contactId)throw new Error('历史处理范围已变化');
      const result=await bridge.startHistory({contactId,scopeRevision,requestKey,connectionGeneration:view.connectionGeneration});
      if(!valid())return;
      if(result.status==='started'){
        if(result.view.contactId!==contactId)throw new Error('历史处理范围已变化');
        const status=result.view.run?.status;
        const message=status==='completed'?'本次历史聊天已处理完成。':status==='paused'?'已核对原任务，当前仍处于暂停状态。'
          :status==='blocked'?'已核对原任务，当前仍有处理阻碍。':'历史处理请求已受理，请查看上方进度。';
        request.current=null;setNotice({scope:accepted,phase:'started',message});onStarted();
      }else{
        setNotice({scope:accepted,phase:'failed',message:reasons[result.reason]??'历史处理暂不可启动，请重新核对。'});
      }
    }catch{
      if(valid())setNotice({scope:accepted,phase:'failed',message:'启动结果暂未确认，请重试核对；重复点击会沿用同一次请求。'});
    }finally{if(pending.current===operation)pending.current=null;}
  };
  return <section className="memory-processing-card memory-history-processing" aria-label="历史聊天记忆处理">
    <h3>历史聊天</h3>
    <p className="memory-section-note">历史导入完成后会自动分批处理；增量文字独立排队。手动启动同样会跳过已完成内容。</p>
    <button className="button primary" type="button" disabled={!contactId||current?.phase==='starting'} onClick={()=>void start()}>{current?.phase==='starting'?'正在启动…':'处理历史聊天'}</button>
    {!contactId&&<p>请先选择联系人。</p>}
    {current?.phase==='started'&&<p role="status">{current.message}</p>}
    {current?.phase==='failed'&&<p role="alert">{current.message}</p>}
  </section>;
}
