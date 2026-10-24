import {ReplyContextError,type ReplyContextEvidence,type BuiltReplyContext} from './reply-context-types.ts';

export const REPLY_RECENT_MESSAGE_LIMIT=50;
/** 最近最多50条整条消息；显式目标优先，其余保留输入的最近连续顺序。 */
export function selectReplyMessageWindow(messages:readonly ReplyContextEvidence[],target?:string):ReplyContextEvidence[]{
 const anchor=target?messages.find(e=>e.evidence_id===target):undefined;
 if(target&&!anchor)throw new ReplyContextError('待回复消息不在当前有效范围。');
 const selected=anchor?[anchor]:[];
 for(const item of messages){if(item===anchor)continue;if(selected.length>=REPLY_RECENT_MESSAGE_LIMIT)break;selected.push(item);}
 return selected;
}

/** 只复验消息数量与目标身份；成功历史工具回执仍属于独立来源窗口轨。 */
export function requireReplyMessageWindowCount(context:BuiltReplyContext):void {
 const tools=new Set((context.tool_calls??[]).filter(t=>t.status==='succeeded'&&['conversation_search','conversation_query'].includes(t.tool_name)).flatMap(t=>t.evidence_ids??[]));
 const recent=context.evidence.filter(e=>e.kind==='message'&&e.model_visible&&!(tools.has(e.evidence_id)&&['本轮相关性搜索返回的联系人历史消息。','本轮时间顺序查询返回的联系人历史消息。'].includes(e.selection_reason)));
 if(context.command.content.type==='reply_to_message'){
  const target=recent.find(e=>e.evidence_id===context.command.content.target_message_id);
  if(!target||target.text!==context.current_text)throw new ReplyContextError('待回复消息缺少可见窗口身份或正文已变化。');
 }
 if(recent.length>REPLY_RECENT_MESSAGE_LIMIT)throw new ReplyContextError('冻结近期消息超出50条；保留原快照，请明确重新准备。');
}
