import type {Context} from '@deepseek-ai/cordis';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {RELATIONSHIP_SEARCH_DEFINITIONS,REPLY_SEARCH_BUDGET,type RelationshipSearchKind} from './retrieval-policy.ts';
import {renderRelationshipSearchResult,type RelationshipSearchResultView} from './evidence-use.ts';

export {RELATIONSHIP_SEARCH_TOOLS,type RelationshipSearchKind} from './retrieval-policy.ts';
type SearchResult=RelationshipSearchResultView;

/** 身份、冻结范围、来源及实际输入记账由本轮闭包负责；模型只提供查询词。 */
export function installRelationshipSearchTools(ctx:Context,search:(kind:RelationshipSearchKind,query:string,signal:AbortSignal)=>Promise<SearchResult>,check:()=>Promise<void>,failed:(error:unknown)=>void):void{
 for(const {kind,name,description} of RELATIONSHIP_SEARCH_DEFINITIONS){
  ctx.tools.register(defineTool({name,description,
   parameters:{query:{type:'string',required:true,description:`围绕本次信息缺口，结合已有语境组织的具体查询词，非空且最多${REPLY_SEARCH_BUDGET.queryChars}个字符。`}},
   async execute(args,exec){
    try{
     exec.signal.throwIfAborted();await check();exec.signal.throwIfAborted();
     const query=args.query.trim();
     if(!query||[...query].length>REPLY_SEARCH_BUDGET.queryChars||Object.keys(args).some(key=>key!=='query'))return {text:`本次查询被拒绝，未读取正文：只接受非空且最多${REPLY_SEARCH_BUDGET.queryChars}个字符的query，不接受身份或范围参数。`};
     const result=await search(kind,query,exec.signal);
     exec.signal.throwIfAborted();await check();exec.signal.throwIfAborted();
     return {text:renderRelationshipSearchResult(result)};
    }catch(error){failed(error);throw error;}
   },
   output:{schema:{type:'object',additionalProperties:false,properties:{text:{type:'string',required:true}}},render:(_args,value)=>[{type:'text',text:value.text}]},
  }));
 }
}
