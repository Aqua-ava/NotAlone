import type { SavedContactBinding } from '../../contacts/sqlite/contracts.ts';
import type { HistoryCoverage } from './contracts.ts';

export async function readStatusCoverages(bindings: Pick<SavedContactBinding, 'binding_id'|'contact_id'|'status'>[],
  coverage: (contactId: string) => Promise<HistoryCoverage>): Promise<(HistoryCoverage & {bindingId:string})[]> {
 const result:(HistoryCoverage & {bindingId:string})[]=[];
 // SQLite 只有一个工作队列，小批提交使前台观察可以在批次之间执行。
 const active=bindings.filter(binding=>binding.status==='active');
 for(let index=0;index<active.length;index+=4){
  const batch=active.slice(index,index+4);
  result.push(...await Promise.all(batch.map(async binding=>({...await coverage(binding.contact_id),bindingId:binding.binding_id}))));
 }
 return result;
}
