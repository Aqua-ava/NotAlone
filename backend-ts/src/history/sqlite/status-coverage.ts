import type { SavedContactBinding } from '../../contacts/sqlite/contracts.ts';
import type { HistoryCoverage } from './contracts.ts';

export async function readStatusCoverages(bindings: Pick<SavedContactBinding, 'binding_id'|'contact_id'|'status'>[],
  coverage: (contactId: string) => Promise<HistoryCoverage>,
  batchCoverage?: (contactIds: readonly string[]) => Promise<HistoryCoverage[]>): Promise<(HistoryCoverage & {bindingId:string})[]> {
 const result:(HistoryCoverage & {bindingId:string})[]=[];
 // SQLite 只有一个工作队列，小批提交使前台观察可以在批次之间执行。
 const active=bindings.filter(binding=>binding.status==='active');
 const byContact=new Map<string,HistoryCoverage>();
 for(let index=0;index<active.length;index+=16){
  const batch=active.slice(index,index+16),contactIds=batch.map(binding=>binding.contact_id);
  const rows=batchCoverage?await batchCoverage(contactIds):await Promise.all(contactIds.map(coverage));
  if(rows.length!==contactIds.length||rows.some((row,offset)=>row.contactId!==contactIds[offset]))throw new Error('同步覆盖报告不可用。');
  rows.forEach(row=>byContact.set(row.contactId,row));
 }
 for(const binding of active){const row=byContact.get(binding.contact_id);if(!row)throw new Error('同步覆盖报告不可用。');result.push({...row,bindingId:binding.binding_id});}
 return result;
}
