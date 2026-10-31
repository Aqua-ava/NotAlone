import {createHash} from 'node:crypto';
import {StorageFailure} from '../../../storage/sqlite/contracts.ts';

export type ReplyWorkspaceTone='original'|'warm'|'concise'|'polite';
export interface ReplyWorkspace {
 action:'express'|'suggest';draftText:string;tone:ReplyWorkspaceTone;instruction:string;contextText:string;
 includeRelationshipContext:boolean;excludedMessageIds:string[];
}
export interface ReplyWorkspaceSnapshot extends ReplyWorkspace {
 selectedPackageId:string|null;carriedSelectionId:string|null;
}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const invalid=():never=>{throw new StorageFailure('reply_input_invalid');};
/** 将本地工作区输入收敛成固定字段；排除项按集合排序以保持请求重试稳定。 */
export function readReplyWorkspace(value:unknown):ReplyWorkspace{
 if(!value||typeof value!=='object'||Array.isArray(value))return invalid();
 const w=value as Record<string,unknown>;
 if(Object.keys(w).some(key=>!['action','draftText','tone','instruction','contextText','includeRelationshipContext','excludedMessageIds'].includes(key))
  ||!['express','suggest'].includes(String(w.action))||typeof w.draftText!=='string'||w.draftText.length>100000
  ||w.action==='express'&&!w.draftText.trim()||!['original','warm','concise','polite'].includes(String(w.tone))
  ||typeof w.instruction!=='string'||w.instruction.length>100000||typeof w.contextText!=='string'||w.contextText.length>100000
  ||typeof w.includeRelationshipContext!=='boolean'||!Array.isArray(w.excludedMessageIds)||w.excludedMessageIds.length>50
  ||w.excludedMessageIds.some(id=>!uuid(id))||new Set(w.excludedMessageIds).size!==w.excludedMessageIds.length)return invalid();
 const workspace={action:w.action as ReplyWorkspace['action'],draftText:w.draftText,tone:w.tone as ReplyWorkspaceTone,instruction:w.instruction,
  contextText:w.contextText,includeRelationshipContext:w.includeRelationshipContext,excludedMessageIds:[...(w.excludedMessageIds as string[])].sort()};
 if(replyWorkspaceEntryText(workspace).length>100000)return invalid();
 return workspace;
}
/** user entry保存可读内容；隐藏设置单独指纹化，避免将内部参数塞进对话正文。 */
export function replyWorkspaceEntryText(workspace:ReplyWorkspace):string{
 return [`工作区动作：${workspace.action==='suggest'?'帮我想想（尚未确认立场）':'帮我表达'}`,
  `本次想法/草稿：\n${workspace.draftText||'（未提供；用户尚未确认任何立场）'}`,
  `本次补充背景：\n${workspace.contextText||'（未提供）'}`,
  `本次语气：${toneLabel(workspace.tone)}`,
  `本次要求：\n${workspace.instruction||'（未提供）'}`,
  `关系背景：${workspace.includeRelationshipContext?'已启用':'已关闭'}`].join('\n\n');
}
export function replyWorkspaceFingerprint(workspace:ReplyWorkspace,selectedPackageId?:string,carriedSelectionId?:string):string{
 return createHash('sha256').update(JSON.stringify({version:1,workspace,selectedPackageId:selectedPackageId??null,carriedSelectionId:carriedSelectionId??null})).digest('hex');
}
export function toneLabel(tone:ReplyWorkspaceTone):string{
 return ({original:'保持本次原意',warm:'温和自然',concise:'简洁',polite:'礼貌'} as const)[tone];
}
