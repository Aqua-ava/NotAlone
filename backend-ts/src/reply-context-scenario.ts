/** 本次实际目录的完整单段读取与累计回执；调用方保持同一事务/范围锁。 */
import type {Client} from 'pg';
import {replyUuid} from './reply-contract.ts';
import {canonicalJSON} from './contact-overview-evidence.ts';
import {pythonISO} from './contact-overview-time.ts';
import {validateLayeredSnapshot,payloadJSON,type LayeredMaterial} from './reply-context-layered.ts';
import {ReplyContextError,type ContextMetadata,type BuiltReplyContext} from './reply-context-types.ts';
const fail=():never=>{throw new ReplyContextError('正文工具回执与冻结范围或累计额度不一致。');};
const fields=(value:ContextMetadata,keys:string[])=>canonicalJSON(Object.keys(value).sort())===canonicalJSON([...keys].sort());
type ScenarioContext=Pick<BuiltReplyContext,'layered_context'|'owner_layered_context'>;
interface ScenarioReadSide {side:'contact'|'owner';material:LayeredMaterial;call_limit:number}
function scenarioCallLimit(material:LayeredMaterial):number|null{
 let limits:unknown;try{limits=JSON.parse(material.payload_json).scenario_read_budget;}catch{throw new ReplyContextError('正文读取预算无效。');}
 if(limits===null||limits===undefined)return null;
 if(typeof limits!=='object'||Array.isArray(limits)||!Number.isInteger((limits as ContextMetadata).call_limit)||(limits as ContextMetadata).call_limit<1||(limits as ContextMetadata).call_limit>8)throw new ReplyContextError('正文读取调用额度须为1至8的整数。');
 return (limits as ContextMetadata).call_limit;
}
/** 工具注册与模型轮数共同读取本次实际材料；不从当前数据库补回已裁剪或冻结的预算。 */
export function replyScenarioReadPolicy(context:ScenarioContext):{reads:ScenarioReadSide[];call_limit:number}{
 const reads:ScenarioReadSide[]=[];
 for(const [side,material] of [['contact',context.layered_context],['owner',context.owner_layered_context]] as const){
  if(!material)continue;const call_limit=scenarioCallLimit(material);if(call_limit!==null)reads.push({side,material,call_limit});
 }
 return {reads,call_limit:reads.reduce((sum,entry)=>sum+entry.call_limit,0)};
}
/** 旧生产16个图步骤对应8个模型轮；每个实际场景读取额度增加一个模型轮。 */
export function replyPhysicalLimit(context:ScenarioContext,serverCap:number):number{
 if(!Number.isSafeInteger(serverCap)||serverCap<1)throw new ReplyContextError('模型物理调用上限无效。');
 return Math.min(serverCap,8+replyScenarioReadPolicy(context).call_limit);
}
export function requireScenarioReceipts(material:LayeredMaterial,receipts:readonly ContextMetadata[]):void{
 if(!Array.isArray(receipts))fail();if(!receipts.length)return;
 const payload=JSON.parse(material.payload_json),limits=payload.scenario_read_budget;if(!limits)fail();
 const directory=new Map<string,ContextMetadata>(payload.directory.map((row:ContextMetadata)=>[row.scenario_id,row]));
 let paragraphs=0,characters=0;const seen=new Set<string>();
 for(const [index,receipt] of receipts.entries()){
  const success=receipt.status==='succeeded',expectedFields=['schema_version','status','reason','scenario_id','paragraph_range','budget',...(success?['document']:[])];
  if(!fields(receipt,expectedFields)||receipt.schema_version!==1||!['succeeded','duplicate','out_of_range','not_in_directory','invalid_arguments','stale','budget_exceeded'].includes(receipt.status)||typeof receipt.reason!=='string'||!receipt.reason.trim())fail();
  if(success){const entry=directory.get(receipt.scenario_id),span=receipt.paragraph_range,document=receipt.document;
   if(!entry||!Array.isArray(span)||span.length!==2||!span.every(Number.isInteger)||!(0<=span[0]&&span[0]<span[1]&&span[1]<=entry.paragraph_count)||!document||!fields(document,['scenario_id','version_id','title','hint','system_generated','updated_at','paragraphs','paragraph_range','organization_generation'])||['scenario_id','version_id','title','hint'].some(key=>document[key]!==entry[key])||document.system_generated!==true||document.organization_generation!==material.snapshot.organization_generation||canonicalJSON(document.paragraph_range)!==canonicalJSON(span)||!Array.isArray(document.paragraphs)||document.paragraphs.length!==span[1]-span[0]||document.paragraphs.some((row:ContextMetadata)=>typeof row.text!=='string'||!row.text.trim()||!Array.isArray(row.references)||!row.references.length)||index>=limits.call_limit)fail();
   for(let i=span[0];i<span[1];i++){const key=`${entry!.scenario_id}/${i}`;if(seen.has(key))fail();seen.add(key);paragraphs++;}
   characters += [...payloadJSON(document)].length;
  }
  const budget={...limits,used_calls:Math.min(index+1,limits.call_limit),used_paragraphs:paragraphs,used_characters:characters};
  if(!receipt.budget||!fields(receipt.budget,Object.keys(budget))||Object.entries(budget).some(([key,value])=>!Number.isInteger(receipt.budget[key])||receipt.budget[key]!==value)||paragraphs>limits.paragraph_limit||characters>limits.character_limit)fail();
 }
}
export async function readScenarioParagraph(client:Client,material:LayeredMaterial,scenarioId:string,index:number):Promise<ContextMetadata>{
 const directory=JSON.parse(material.payload_json).directory as ContextMetadata[];
 const entry=directory.find(row=>row.scenario_id===scenarioId);
 if(!entry||!Number.isInteger(index)||index<0||index>=entry.paragraph_count)throw new ReplyContextError('主题或段落不在实际目录内。');
 if(!await validateLayeredSnapshot(client,material.snapshot))throw new ReplyContextError('主题资料快照已失效。');
 const scope=material.snapshot.scope;
 const row=(await client.query(`SELECT to_jsonb(v) AS value,to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||'+00:00' AS updated_at FROM public.scenario_document_version v WHERE id=$1 AND owner_id=$2 AND contact_id IS NOT DISTINCT FROM $3::uuid`,[entry.version_id,scope.owner_id,scope.contact_id])).rows[0];
 if(!row)throw new ReplyContextError('主题版本已删除。');
 return {scenario_id:row.value.scenario_id,version_id:row.value.id,title:row.value.title,hint:row.value.hint,system_generated:true,updated_at:pythonISO(row.updated_at),paragraphs:row.value.paragraphs.slice(index,index+1),paragraph_range:[index,index+1],organization_generation:material.snapshot.organization_generation};
}
export class ReplyScenarioAccess {
 private readonly material:LayeredMaterial;private readonly saved:ContextMetadata[]=[];private pending:Promise<unknown>=Promise.resolve();
 constructor(material:LayeredMaterial){if(scenarioCallLimit(material)===null)throw new ReplyContextError('缺少正文工具预算。');this.material=structuredClone(material);}
 get receipts():ContextMetadata[]{return structuredClone(this.saved);}
 read(client:Client,args:Record<string,unknown>):Promise<ContextMetadata>{const operation=this.pending.then(()=>this.perform(client,args));this.pending=operation.catch(()=>{});return operation;}
 private async perform(client:Client,args:Record<string,unknown>):Promise<ContextMetadata>{
  const payload=JSON.parse(this.material.payload_json),limits=payload.scenario_read_budget,previous=this.saved.at(-1)?.budget;
  let calls=previous?.used_calls??0,paragraphs=previous?.used_paragraphs??0,characters=previous?.used_characters??0,id:string|null=null;
  try{id=replyUuid(args.scenario_id);}catch{}
  const index=args.paragraph_index,span=Number.isInteger(index)?[index as number,(index as number)+1]:null;
  const finish=(status:string,reason:string,document?:ContextMetadata)=>{const receipt={schema_version:1,status,reason,scenario_id:id,paragraph_range:span,budget:{...limits,used_calls:calls,used_paragraphs:paragraphs,used_characters:characters},...(document?{document}:{})};requireScenarioReceipts(this.material,[...this.saved,receipt]);this.saved.push(receipt);return structuredClone(receipt);};
  if(calls>=limits.call_limit)return finish('budget_exceeded','正文工具调用额度已用尽。');calls++;
  if(!fields(args,['scenario_id','paragraph_index'])||!id||!span)return finish('invalid_arguments','只接受目录稳定ID和整数段落序号。');
  const entry=payload.directory.find((row:ContextMetadata)=>row.scenario_id===id);if(!entry)return finish('not_in_directory','主题不在本次实际目录内。');
  if(span[0]<0||span[1]>entry.paragraph_count)return finish('out_of_range','段落序号超出本次目录。');
  if(this.saved.some(row=>row.status==='succeeded'&&row.scenario_id===id&&row.paragraph_range[0]<=span[0]&&span[0]<row.paragraph_range[1]))return finish('duplicate','本次已经读取该段落。');
  if(paragraphs+1>limits.paragraph_limit)return finish('budget_exceeded','累计段落额度不足；不截断段落。');
  let document:ContextMetadata;try{document=await readScenarioParagraph(client,this.material,id,span[0]);}catch(error){if(!(error instanceof ReplyContextError))throw error;return finish('stale','冻结资料已失效；请重新准备。');}
  const count=[...payloadJSON(document)].length;if(characters+count>limits.character_limit)return finish('budget_exceeded','累计正文JSON字符额度不足；不截断段落。');
  paragraphs++;characters+=count;return finish('succeeded','已读取本次冻结主题的完整段落。',document);
 }
}
