import type {Context} from '@deepseek-ai/cordis';
import {defineTool} from '@deepseek-ai/dsh-tools';

export const RELATIONSHIP_SEARCH_TOOLS=['search_relationship_memory','search_relationship_history'] as const;
export type RelationshipSearchKind='memory'|'history';
interface SearchResult {status:string;items:{itemNo:number;kind:string;text:string}[];code?:string;scope?:string}
function renderSearchResult(result:SearchResult):string{
 if(result.status==='ok'&&result.items.length)return result.items.map(item=>`实际输入材料[${item.itemNo}] ${item.kind}\n${item.text}`).join('\n\n');
 if(result.status==='empty'||result.status==='ok')return '本次查询未命中；这不代表相关资料不存在，请保持未知，不据此补写事实。';
 if(result.code==='reply_search_budget_exceeded'||['exhausted','budget_exceeded'].includes(result.status))return '本轮检索预算已耗尽，未读取更多正文。请使用已有材料，缺失信息保持未知。';
 if(['rejected','denied'].includes(result.status))return '本次查询被拒绝，未读取正文。请使用已有材料，不扩大本轮范围。';
 return '本次检索能力暂不可用，未取得可用正文。请使用已有材料，缺失信息保持未知。';
}

/** 身份、冻结范围、来源及实际输入记账由本轮闭包负责；模型只提供查询词。 */
export function installRelationshipSearchTools(ctx:Context,search:(kind:RelationshipSearchKind,query:string,signal:AbortSignal)=>Promise<SearchResult>,check:()=>Promise<void>,failed:(error:unknown)=>void):void{
 for(const [index,name] of RELATIONSHIP_SEARCH_TOOLS.entries()){
  const kind:RelationshipSearchKind=index===0?'memory':'history';
  ctx.tools.register(defineTool({name,description:kind==='memory'?'信息不足时，搜索本轮已确认联系人范围内获准的L1记忆。只读，不改变联系人或读取授权。':'信息不足时，搜索本轮已确认联系人范围内获准的历史消息。只读，不读取微信或扩大联系人范围。',
   parameters:{query:{type:'string',required:true,description:'与本次回复有关的具体查询词，非空且最多400个字符。'}},
   async execute(args,exec){
    try{
     exec.signal.throwIfAborted();await check();exec.signal.throwIfAborted();
     const query=args.query.trim();
     if(!query||[...query].length>400||Object.keys(args).some(key=>key!=='query'))return {text:'本次查询被拒绝，未读取正文：只接受非空且最多400个字符的query，不接受身份或范围参数。'};
     const result=await search(kind,query,exec.signal);
     exec.signal.throwIfAborted();await check();exec.signal.throwIfAborted();
     return {text:renderSearchResult(result)};
    }catch(error){failed(error);throw error;}
   },
   output:{schema:{type:'object',additionalProperties:false,properties:{text:{type:'string',required:true}}},render:(_args,value)=>[{type:'text',text:value.text}]},
  }));
 }
}
