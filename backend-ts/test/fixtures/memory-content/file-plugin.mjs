/** 仅验证扩展接线的合成文件插件；不声明产品已支持真实文件解析。 */
export const fileMemoryContent={
 id:'synthetic.file',version:'1',kinds:['file'],modelInputCost:()=>({images:0,bytes:0}),
 snapshot:()=>({revision:'synthetic-file-v1'}),
 async prepare({message}){return {message:{message_id:String(message.id),text:'合成文件中的固定每周安排',sender:'contact',occurred_at:null,text_representation:'text',content_kind:'file'}};},
};
