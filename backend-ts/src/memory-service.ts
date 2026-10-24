import { HostStorage, HostStorageError } from './host-storage.ts';
import { uuid } from './contact-context.ts';
import { readMemoryRows, memoryPayload } from './memory-read.ts';
import {mutateMemory, type MemoryMutationDependencies} from './memory-mutations.ts';
import {mutateMemoryCandidate} from './memory-mutations-candidate.ts';
import {eraseManagedUpdateBackups,cleanupPreferenceFiles} from './preference-files.ts';
import {createManualMemory} from './memory-manual.ts';
import {listMemoryCandidates} from './memory-candidate-projection.ts';
import { MemoryError } from './memory-errors.ts';

type Row = Record<string,any>;
export function memoryRoute(method:string, pathname:string):boolean {
  return ['GET','POST'].includes(method) && (/^\/api\/contacts\/[^/]+\/(memories|owner-memories|memory-candidates)(\/[^/]+\/(versions|confirm|discard|apply-update|correct|delete|revert-auto-update))?$/.test(pathname)
    || /^\/api\/memories\/(owner(\/[^/]+\/(versions|correct|delete|revert-auto-update))?|manual-contact|manual-owner)$/.test(pathname));
}
/** 宿主认证后调用；事务完成前再次检查取消，领域不拥有DSH生命周期。 */
export class MemoryService {
  private readonly storage:HostStorage;
  private readonly dependencies:MemoryMutationDependencies;
  constructor(storage:HostStorage,dependencies:MemoryMutationDependencies={}) { this.storage=storage;this.dependencies=dependencies; }
  async handle(method:string,url:URL,body?:unknown,assertCurrent:()=>void=()=>{}):Promise<Row> {
    assertCurrent();
    const owner=this.storage.runtimeOwnerId?.toLowerCase();
    if(!owner) throw new MemoryError('memory_unavailable',503);
    const parts=url.pathname.split('/').filter(Boolean);
    let contact=parts[1]==='contacts'?parts[2].toLowerCase():undefined;
    if(method==='POST'&&parts[2]==='manual-contact') {
      if(!body||typeof body!=='object'||Array.isArray(body)||typeof (body as Row).contact_id!=='string')throw new MemoryError();
      contact=(body as Row).contact_id.toLowerCase();
    }
    if(contact&&!uuid.test(contact)) throw new MemoryError();
    const result=await this.storage.businessTransaction(async client=>{
      if(contact) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`contact:${owner}:${contact}`]);
        if(method!=='GET'&&!(await client.query('SELECT 1 FROM public.contact WHERE owner_id=$1 AND id=$2',[owner,contact])).rowCount) throw new MemoryError('memory_not_found',404);
      }
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${owner}`]);
      let result:Row;
      const contactPath=parts[1]==='contacts';
      const segment=contactPath?parts[3]:parts[2];
      const id=contactPath?parts[4]:parts[3];
      const action=contactPath?parts[5]:parts[4];
      if(id&&!uuid.test(id))throw new MemoryError();
      if(method==='GET'&&segment==='memory-candidates'&&contact&&!id)result={candidates:await listMemoryCandidates(client,owner,contact)};
      else if(method==='GET'&&['memories','owner-memories','owner'].includes(segment)&&(!id||action==='versions')) {
        const level=segment==='memories'?'contact':'owner';
        const rows=await readMemoryRows(client,owner,{level,contactId:contact},id);
        const values=[];
        for(const row of rows)values.push(await memoryPayload(client,row,level));
        result=id?{versions:values}:{memories:values};
      } else if(method==='POST'&&!id&&['manual-contact','manual-owner','owner-memories'].includes(segment)) {
        const level=segment==='manual-contact'?'contact':'owner';
        result={memory:await memoryPayload(client,await createManualMemory(client,owner,{level,contactId:contact},body,this.dependencies.erasurePorts),level)};
      } else if(method==='POST'&&id&&['memories','owner-memories','owner'].includes(segment)&&['correct','delete','revert-auto-update'].includes(action)) {
        const level=segment==='memories'?'contact':'owner';
        if(level==='owner'&&contact)await readMemoryRows(client,owner,{level,contactId:contact},id);
        if(action!=='delete'&&(!body||typeof body!=='object'||Array.isArray(body)))throw new MemoryError();
        if(action==='revert-auto-update'&&Object.keys(body as Row).join('|')!=='expected_revision')throw new MemoryError();
        const row=await mutateMemory(client,owner,{level,contactId:contact},action,id,(body??{}) as Row,{...this.dependencies,beforeErase:()=>eraseManagedUpdateBackups(client,this.storage.runtimeEnvironment())});
        result={memory:await memoryPayload(client,row,level)};
      } else if(method==='POST'&&segment==='memory-candidates'&&contact&&id&&['confirm','discard','apply-update'].includes(action)) {
        const row=await mutateMemoryCandidate(client,owner,contact,action,id,body,{...this.dependencies,beforeErase:()=>eraseManagedUpdateBackups(client,this.storage.runtimeEnvironment())});
        result=action==='discard'?{candidate_id:row.id}:{memory:await memoryPayload(client,row,row.contact_id?'contact':'owner')};
      } else throw new MemoryError('not_found',404);
      assertCurrent();
      return result;
    }).catch(error=>{
      if(error instanceof MemoryError) throw error;
      if(error instanceof HostStorageError&&error.code==='update_backup_cleanup_required')throw new MemoryError(error.code,409);
      throw new MemoryError('memory_operation_failed',500);
    });
    if(method==='POST'&&['delete','discard'].includes(url.pathname.split('/').at(-1)!)) {
      try{await cleanupPreferenceFiles(this.storage,owner);}
      catch{throw new MemoryError('memory_operation_failed',500);}
    }
    return result;
  }
}