/** 历史语义用例显式遍历公开分页接口；产品列表不再为测试预载全部版本。 */
export async function readAllManagement(management,scope){
 const result={candidates:[],memories:[]};let cursor,preparing=false;
 do{
  const page=await management.read(scope,cursor?{cursor}:{});
  preparing=page.page?.preparing===true;if(preparing)continue;
  result.candidates.push(...page.candidates);result.memories.push(...page.memories);cursor=page.page?.nextCursor;
 }while(cursor||preparing);
 for(const memory of result.memories){
  const versions=[],decisions=[];let historyCursor;
  do{
   const page=await management.readHistory(scope,memory.id,historyCursor?{cursor:historyCursor}:{});
   versions.unshift(...page.versions);decisions.unshift(...page.decisions);historyCursor=page.nextCursor;
  }while(historyCursor);
  memory.versions=versions;memory.decisions=decisions;
 }
 return result;
}
