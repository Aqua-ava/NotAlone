/** 观察原业务边界；供应商write时间不冒充SDK首token或业务提交。 */
export function fivePhases(events,status,durable){
  const first=type=>events.find(e=>e.type===type)?.at_ms??null;
  const last=type=>events.filter(e=>e.type===type).at(-1)?.at_ms??null;
  const start=first('business_service_start'),queue=first('queue_end'),network=first('network_start'),networkEnd=last('network_end'),save=first('persistence_start'),saved=last('persistence_end'),end=last('business_service_end');
  const points=[start,queue,network,networkEnd,save,saved,end];
  const complete=points.every(Number.isFinite)&&points.every((v,i)=>!i||points[i-1]<=v);
  const boundaries=[['queue',start,queue],['retrieval',queue,network],['network_model',network,networkEnd],['validation',networkEnd,save],['persistence',save,saved]];
  return {schema_version:'skill-observed-latency-v1',clock:'process_monotonic_relative',complete,
    phases:Object.fromEntries(boundaries.map(([name,a,b])=>[name,Number.isFinite(a)&&Number.isFinite(b)?{started_ms:a,ended_ms:b}:null])),
    first_event_ms:first('model_stream_chunk'),first_token_ms:events.find(e=>e.type==='model_stream_chunk'&&e.is_token_delta)?.at_ms??null,
    final_persisted_result_ms:status==='succeeded'&&durable?saved:null,observed_ms:end,
    persistence_commit_confirmed:status==='succeeded'&&durable,
    overhead:Number.isFinite(saved)&&Number.isFinite(end)?{started_ms:saved,ended_ms:end}:null,
    unknown_reason:complete?null:'失败或取消没有业务保存边界；缺失值保持null，不从供应商写出时间补造。',
    definitions:{queue:'业务接纳至持久claim取得；包括授权准备，不是纯调度等待',retrieval:'claim后原材料重取、模型准备与许可，至真实SDK开始',
      network_model:'原SDK调用/stream开始至结束；不等于供应商单独延迟',validation:'SDK结束至原Store.save调用',persistence:'原Store.save进入至真实事务返回'}};
}
