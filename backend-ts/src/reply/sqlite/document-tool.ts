import type {Context} from '@deepseek-ai/cordis';
import {defineTool} from '@deepseek-ai/dsh-tools';
export const RELATIONSHIP_DOCUMENT_TOOL='read_relationship_document';
/** 只有宿主提供冻结目录时安装；模型不能指定联系人、路径或版本。 */
export function installRelationshipDocumentTool(ctx:Context,read:(range:{itemNo:number;startBlock:number;blockCount:number})=>Promise<{itemNo:number;text:string}>,check:()=>Promise<void>,failed:(error:unknown)=>void):void{
 ctx.tools.register(defineTool({name:RELATIONSHIP_DOCUMENT_TOOL,description:'按本轮主题目录材料编号读取完整段落。起始段落从1开始，每次最多3段且1800字符，本轮最多2次成功读取；不得将目录当作正文。',
  parameters:{itemNo:{type:'integer',required:true,description:'本轮主题目录的材料编号。'},startBlock:{type:'integer',required:true,description:'起始段落编号，从1开始。'},blockCount:{type:'integer',required:true,description:'读取完整段落数量，1至3。'}},
  async execute(args,exec){
   try{exec.signal.throwIfAborted();await check();const value=await read({itemNo:args.itemNo,startBlock:args.startBlock,blockCount:args.blockCount});exec.signal.throwIfAborted();await check();return {text:`实际输入材料[${value.itemNo}] document\n${value.text}`};}
   catch(error){
    if(['reply_document_range_invalid','reply_document_budget_exceeded'].includes((error as {code?:string}).code??''))return {text:'资料读取被拒绝：材料编号或段落范围无效，或本轮完整段落预算已用尽。请使用已有材料，不扩大读取范围。'};
    failed(error);throw error;
   }
  },
  output:{schema:{type:'object',additionalProperties:false,properties:{text:{type:'string',required:true}}},render:(_args,value)=>[{type:'text',text:value.text}]},
 }));
}
