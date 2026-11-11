import {Worker} from 'node:worker_threads';
import {currentDiagnosticTrace,newTraceId} from '../../diagnostics/context.ts';
import {publishStorageDiagnostics} from '../../diagnostics/storage-events.ts';
import {sqliteOpenTimeoutMs} from './timeouts.ts';
import {StorageFailure,type StorageReader,type StorageStatus} from './contracts.ts';
const terminalCodes=new Set(['stale_lease','storage_identity_changed','unsafe_storage_path','storage_missing','schema_drift','migration_drift']);

export interface ReadonlyWorkerOptions {
  userData:string;
  registryModule?:string;
  status:StorageStatus;
  actions:readonly string[];
  fileIdentity:{dev:number;ino:number};
}

/** 附属于唯一写者的具名只读连接；关闭完成才释放所有者持有的资源。 */
export class SqliteReadonlyReader implements StorageReader {
  readonly ready:Promise<void>;
  private readonly worker:Worker;
  private readonly actions:Set<string>;
  private readonly pending=new Map<number,{traceId:string;resolve:(value:any)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();
  private nextId=0;
  private failed=false;
  private closing?:Promise<void>;
  private finishReady!:(error?:Error)=>void;
  private readonly onClosed:()=>void;
  constructor(options:ReadonlyWorkerOptions,onClosed:()=>void){
    if(!Array.isArray(options.actions)||!options.actions.length||options.actions.some(name=>typeof name!=='string'||!/^[a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*$/.test(name)))throw new StorageFailure('readonly_actions_invalid');
    this.actions=new Set(options.actions);
    this.onClosed=onClosed;
    this.worker=new Worker(new URL('./readonly-worker.ts',import.meta.url),{workerData:options,execArgv:['--experimental-strip-types']});
    this.ready=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.finishReady(new StorageFailure('storage_timeout'));void this.close();},sqliteOpenTimeoutMs);
      let finished=false;
      this.finishReady=error=>{if(finished)return;finished=true;clearTimeout(timer);if(error)reject(error);else resolve();};
    });
    this.worker.on('message',message=>{
      if(message.ready===true){this.finishReady();return;}
      if(message.id===undefined){this.finishReady(new StorageFailure(message.code??'worker_failed'));void this.close();return;}
      const pending=this.pending.get(message.id);if(!pending)return;
      clearTimeout(pending.timer);this.pending.delete(message.id);
      publishStorageDiagnostics(message.diagnostics,pending.traceId,{observedAt:message.diagnosticObservedAt,observedNs:message.diagnosticObservedMonotonicNs});
      if(message.code){pending.reject(new StorageFailure(message.code));if(terminalCodes.has(message.code))void this.close();}
      else pending.resolve(message.value);
    });
    this.worker.on('error',()=>this.fail());
    this.worker.on('exit',()=>this.fail());
  }
  execute<T=unknown>(name:string,input:unknown):Promise<T>{
    if(this.failed||this.closing)return Promise.reject(new StorageFailure('readonly_closed'));
    if(!this.actions.has(name))return Promise.reject(new StorageFailure('readonly_action_forbidden'));
    const id=++this.nextId;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.fail();},15_000);
      const traceId=currentDiagnosticTrace()??newTraceId();
      this.pending.set(id,{traceId,resolve,reject,timer});
      try{this.worker.postMessage({id,name,input,traceId});}catch{this.fail();}
    });
  }
  close():Promise<void>{
    return this.closing??=(async()=>{
      this.failed=true;this.finishReady(new StorageFailure('readonly_closed'));
      for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(new StorageFailure('readonly_closed'));}
      this.pending.clear();
      // 活动读没有写入；等待终止确认，确保没有迟到结果或遗留的 WAL 读事务。
      await this.worker.terminate();this.onClosed();
    })();
  }
  private fail():void{if(this.failed)return;void this.close();}
}
