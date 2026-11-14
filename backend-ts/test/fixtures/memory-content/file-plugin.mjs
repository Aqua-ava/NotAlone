import {createHash} from 'node:crypto';
export const fileContentText='我每周三参加合成读书会。';
/** 仅验证扩展接线的合成文件插件；不声明产品已支持真实文件解析。 */
export const fileMemoryContent={
 id:'synthetic.file',version:'1',kinds:['file'],modelInputCost:()=>({images:0,bytes:0}),
 snapshot:()=>({revision:'synthetic-file-v1',text:fileContentText,sha256:createHash('sha256').update(fileContentText).digest('hex')}),
 evidence:(_tx,{frozen})=>({representation:'text',text:String(frozen.identity.text)}),
 async prepare({message,frozen}){return {message:{message_id:String(message.id),text:String(frozen.identity.text),sender:'contact',occurred_at:null,text_representation:'text',content_kind:'file'}};},
};
