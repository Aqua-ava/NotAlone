import {projectReplyEvidence} from './reply-evidence-payload.ts';
import {ReplyContextError,type ReplyContextEvidence,type BuiltReplyContext} from './reply-context-types.ts';

export const REPLY_RECENT_MESSAGE_LIMIT=50;
export const REPLY_RECENT_MESSAGE_TOKEN_LIMIT=8000;
/** 仅为独立窗口的UTF-8字节估算，不是供应商tokenizer或精确上界。 */
export function measureReplyMessageWindow(messages:readonly ReplyContextEvidence[]){
 const projected=messages.map(e=>projectReplyEvidence(e));
 return {measurement_kind:'approximate' as const,measurement_id:'reply-recent-message-evidence-json-utf8-bytes-v1',input_tokens:Buffer.byteLength(JSON.stringify(projected),'utf8'),token_limit:REPLY_RECENT_MESSAGE_TOKEN_LIMIT};
}
/** 仅供新窗口选择；固定ID资格复验和旧冻结恢复必须继续使用无裁剪读取。 */
export function selectReplyMessageWindow(messages:readonly ReplyContextEvidence[],target?:string):ReplyContextEvidence[]{
 const selected:ReplyContextEvidence[]=[];
 const anchor=target?messages.find(e=>e.evidence_id===target):undefined;
 if(target&&!anchor)throw new ReplyContextError('待回复消息不在当前有效范围。');
 if(anchor){if(measureReplyMessageWindow([anchor]).input_tokens>REPLY_RECENT_MESSAGE_TOKEN_LIMIT)throw new ReplyContextError('待回复消息超出近期窗口8000估算token预算，请明确选择可合法处理的输入。');selected.push(anchor);}
 // 显式目标先占同一预算，其余资料遵循最近连续整条前缀；超限即停止，不跳过长消息。
 for(const item of messages){if(item===anchor)continue;if(selected.length>=REPLY_RECENT_MESSAGE_LIMIT||measureReplyMessageWindow([...selected,item]).input_tokens>REPLY_RECENT_MESSAGE_TOKEN_LIMIT)break;selected.push(item);}
 return selected;
}

/** 原Python近期/目标标签默认计入；只有带成功工具回执的原工具标签属于独立来源窗口轨。 */
export function requireReplyMessageWindowBudget(context:BuiltReplyContext):void {
 const tools=new Set((context.tool_calls??[]).filter(t=>t.status==='succeeded'&&['conversation_search','conversation_query'].includes(t.tool_name)).flatMap(t=>t.evidence_ids??[]));
 const recent=context.evidence.filter(e=>e.kind==='message'&&e.model_visible&&!(tools.has(e.evidence_id)&&['本轮相关性搜索返回的联系人历史消息。','本轮时间顺序查询返回的联系人历史消息。'].includes(e.selection_reason)));
 if(context.command.content.type==='reply_to_message'){
  const target=recent.find(e=>e.evidence_id===context.command.content.target_message_id);
  if(!target||target.text!==context.current_text)throw new ReplyContextError('待回复消息缺少可见窗口身份或正文已变化。');
 }
 if(recent.length>REPLY_RECENT_MESSAGE_LIMIT||measureReplyMessageWindow(recent).input_tokens>REPLY_RECENT_MESSAGE_TOKEN_LIMIT)throw new ReplyContextError('冻结近期消息超出50条或8000估算token预算；保留原快照，请明确重新准备。');
}
