import type { SavedContactBinding } from '../../contacts/sqlite/contracts.ts';
import type { HistoryCoverage } from './contracts.ts';

type StatusBinding = Pick<SavedContactBinding, 'binding_id'|'contact_id'|'status'>;
type StatusCoverage = HistoryCoverage & {bindingId:string};
type BatchCoverage = (contactIds: readonly string[]) => Promise<HistoryCoverage[]>;

export async function readStatusCoverages(bindings: StatusBinding[],batchCoverage: BatchCoverage): Promise<StatusCoverage[]> {
 const result:StatusCoverage[]=[];
 // SQLite 只有一个工作队列；每批四位兼顾调度开销，并缩短前台观察的等待。
 const batchSize=4;
 const active=bindings.filter(binding=>binding.status==='active');
 for(let index=0;index<active.length;index+=batchSize){
  const batch=active.slice(index,index+batchSize);
  const rows=await batchCoverage(batch.map(binding=>binding.contact_id));
  if(rows.length!==batch.length)throw new Error('同步覆盖报告不可用。');
  for(const [offset,binding] of batch.entries()){
   const row=rows[offset];
   // 没有历史目标的行可能不带绑定。已有目标与本次目录的绑定不同，则整份报告须重新读取。
   if(!row||row.contactId!==binding.contact_id||row.bindingId!==null&&row.bindingId!==binding.binding_id)throw new Error('同步覆盖报告不可用。');
   result.push({...row,bindingId:binding.binding_id});
  }
 }
 return result;
}

/**
 * 状态轮询的覆盖复用：覆盖只取决于库内容。上次完整读取前后库代次一致、此刻代次仍未变且授权目录相同，
 * 说明其间没有任何可写动作开始执行，直接返回上次结果的副本；否则（含代次不可知时）照常逐批重算。
 * 授权目录由调用方每次现读，撤销、停读、删除与同步写入都会推进代次。
 */
export class StatusCoverageMemo {
 readonly #generation: () => number | undefined;
 #last?: { generation: number; key: string; rows: StatusCoverage[] };
 constructor(generation: () => number | undefined) { this.#generation = generation; }
 async read(bindings: StatusBinding[],batchCoverage: BatchCoverage): Promise<StatusCoverage[]> {
  const key=JSON.stringify(bindings.map(binding=>[binding.binding_id,binding.contact_id,binding.status]));
  const before=this.#generation();
  if(before!==undefined&&this.#last?.generation===before&&this.#last.key===key)return structuredClone(this.#last.rows);
  this.#last=undefined;
  const rows=await readStatusCoverages(bindings,batchCoverage);
  if(before!==undefined&&this.#generation()===before)this.#last={generation:before,key,rows:structuredClone(rows)};
  return rows;
 }
}
