import {sha256} from '../../../platform/sha256.ts';
import {StorageFailure} from '../../../storage/sqlite/contracts.ts';

export interface ReplyWorkspace {
 action:'express'|'suggest';draftText:string;contextText:string;
 includeRelationshipContext:boolean;
}
export interface ReplyWorkspaceSnapshot extends ReplyWorkspace {
 selectedPackageId:string|null;carriedSelectionId:string|null;
}
const invalid=():never=>{throw new StorageFailure('reply_input_invalid');};
/** 主输入统一承载想法、语气与要求；退役的独立设置和消息排除字段均拒绝。 */
export function readReplyWorkspace(value:unknown):ReplyWorkspace{
 if(!value||typeof value!=='object'||Array.isArray(value))return invalid();
 const w=value as Record<string,unknown>;
 if(Object.keys(w).some(key=>!['action','draftText','contextText','includeRelationshipContext'].includes(key))
  ||!['express','suggest'].includes(String(w.action))||typeof w.draftText!=='string'||w.draftText.length>100000
  ||w.action==='express'&&!w.draftText.trim()||typeof w.contextText!=='string'||w.contextText.length>100000
  ||typeof w.includeRelationshipContext!=='boolean')return invalid();
 const workspace={action:w.action as ReplyWorkspace['action'],draftText:w.draftText,
  contextText:w.contextText,includeRelationshipContext:w.includeRelationshipContext};
 if(replyWorkspaceEntryText(workspace).length>100000)return invalid();
 return workspace;
}
/** user entry保存可读内容；隐藏设置单独指纹化，避免将内部参数塞进对话正文。 */
export function replyWorkspaceEntryText(workspace:ReplyWorkspace):string{
 return [`工作区动作：${workspace.action==='suggest'?'帮我想想（尚未确认立场）':'帮我表达'}`,
  `本次想法/草稿：\n${workspace.draftText||'（未提供；用户尚未确认任何立场）'}`,
  `本次补充背景：\n${workspace.contextText||'（未提供）'}`,
  `关系背景：${workspace.includeRelationshipContext?'已启用':'已关闭'}`].join('\n\n');
}
export function replyWorkspaceFingerprint(workspace:ReplyWorkspace,selectedPackageId?:string,carriedSelectionId?:string):string{
 return sha256(JSON.stringify({version:3,workspace,selectedPackageId:selectedPackageId??null,carriedSelectionId:carriedSelectionId??null}));
}
