/** 全局流只保留稳定会话标识与 cursor；容量不足即失败，不静默漏事件。 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { IncrementalCliError, parseIncrementalSessionLine } from './sync-incremental-normalize.ts';
import { commandErrorCode } from './sync-incremental-cli-history.ts';
type SessionEvent={cursor:string;conversation_locator:string};
const fail=(code:string)=>new IncrementalCliError(code,'微信会话事件流未完成。');
export class IncrementalSessionStream {
  private child:ChildProcessWithoutNullStreams;
  private queue:SessionEvent[]=[];
  private error:IncrementalCliError|null=null;
  private ended=false;
  private stopped=false;
  private wake:(()=>void)|null=null;
  readonly drained:Promise<void>;
  constructor(child:ChildProcessWithoutNullStreams,options:{maxQueuedEvents:number;maxLineBytes:number;signal?:AbortSignal}){
    this.child=child;
    let buffer='';const decoder=new StringDecoder('utf8');
    const stop=(code:string)=>{this.error??=fail(code);this.queue.length=0;buffer='';child.kill('SIGKILL');this.wake?.();};
    const abort=()=>stop('cli_cancelled');
    options.signal?.addEventListener('abort',abort,{once:true});
    const line=(value:string)=>{
      if(this.stopped||this.error)return;
      try {
        try{const envelope=JSON.parse(value);if(envelope?.ok===false)throw fail(commandErrorCode(value));}catch(error){if(error instanceof IncrementalCliError)throw error;}
        const event=parseIncrementalSessionLine(value);
        if(!event)return;
        if(this.queue.length>=options.maxQueuedEvents){stop('cli_stream_overflow');return;}
        this.queue.push(event);this.wake?.();
      }catch(error){this.error=error instanceof IncrementalCliError?error:fail('cli_output_invalid');stop(this.error.code);}
    };
    child.stdout.on('data',(chunk:Buffer)=>{
      if(this.error||this.stopped)return;
      buffer+=decoder.write(chunk);
      let index:number;
      while((index=buffer.indexOf('\n'))>=0){
        const value=buffer.slice(0,index);buffer=buffer.slice(index+1);
        if(Buffer.byteLength(value)>options.maxLineBytes){stop('cli_output_limit');return;}
        line(value);if(this.error)return;
      }
      if(Buffer.byteLength(buffer)>options.maxLineBytes)stop('cli_output_limit');
    });
    let stderrBytes=0;child.stderr.on('data',(chunk:Buffer)=>{stderrBytes+=chunk.length;if(stderrBytes>options.maxLineBytes)stop('cli_output_limit');});
    child.on('error',(error:NodeJS.ErrnoException)=>stop(error.code==='ENOENT'?'cli_not_found':'cli_command_failed'));
    this.drained=new Promise(resolve=>child.once('close',code=>{
      if(!this.stopped&&!this.error){buffer+=decoder.end();if(buffer.trim())line(buffer);}
      if(code!==0&&!this.stopped&&!this.error)this.error=fail('cli_follow_failed');
      buffer='';this.ended=true;options.signal?.removeEventListener('abort',abort);this.wake?.();resolve();
    }));
    if(options.signal?.aborted)abort();
  }
  get process_id():number|null{return this.child.pid??null;}
  get closed():boolean{return this.stopped||this.ended;}
  async read(options:{timeoutMs?:number;signal?:AbortSignal}={}):Promise<SessionEvent|null>{
    const timeoutMs=options.timeoutMs??1000;
    if(!Number.isFinite(timeoutMs)||timeoutMs<0)throw fail('cli_invalid_argument');
    if(this.wake)throw fail('cli_stream_busy');
    if(options.signal?.aborted)throw fail('cli_cancelled');
    if(!this.error&&!this.stopped&&!this.ended&&!this.queue.length&&timeoutMs>0){
      await new Promise<void>(resolve=>{
        const finish=()=>{clearTimeout(timer);options.signal?.removeEventListener('abort',finish);this.wake=null;resolve();};
        const timer=setTimeout(finish,timeoutMs);this.wake=finish;options.signal?.addEventListener('abort',finish,{once:true});if(options.signal?.aborted)finish();
      });
    }
    if(options.signal?.aborted)throw fail('cli_cancelled');
    if(this.error)throw this.error;
    if(this.stopped)return null;
    const event=this.queue.shift();if(event)return event;
    if(this.ended)throw fail('cli_stream_closed');
    return null;
  }
  async close():Promise<void>{this.stopped=true;this.queue.length=0;this.child.kill('SIGKILL');this.wake?.();await this.drained;}
}
