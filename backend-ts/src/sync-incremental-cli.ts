/** 只读 CLI 进程边界；不接触配置文件，不把 stderr 或调试原文带入业务错误。 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { parseConfiguredWechatAccount } from './wechat-setup-probe.ts';
import { IncrementalCliError, parseIncrementalTail, type IncrementalTailResult } from './sync-incremental-normalize.ts';
import { exactMissingTable, commandErrorCode, localHistorySql, localHistoryState } from './sync-incremental-cli-history.ts';
import { IncrementalSessionStream } from './sync-incremental-cli-stream.ts';
export interface IncrementalCommandOptions { signal?: AbortSignal; timeoutMs?: number }
const textValue=(value:unknown):string=>{if(typeof value!=='string'||!value.trim()||/[\x00-\x1f\x7f]/.test(value)||value.length>1024)throw failure('cli_invalid_argument');return value.trim();};
const failure = (code: string) => new IncrementalCliError(code, '微信只读 CLI 操作未完成。');
interface CliOptions { executable: string; environment?: NodeJS.ProcessEnv; timeoutMs?: number; maxOutputBytes?: number; maxQueuedEvents?: number }
export class SyncIncrementalCli {
  private options:CliOptions;
  private closed = false;
  private streams=new Set<IncrementalSessionStream>();
  private active = new Map<ChildProcessWithoutNullStreams, Promise<void>>();
  constructor(options:CliOptions) {
    this.options=options;
    if (!options.executable.trim()) throw failure('cli_invalid_argument');
    for(const budget of [options.timeoutMs,options.maxOutputBytes,options.maxQueuedEvents])if(budget!==undefined&&(!Number.isSafeInteger(budget)||budget<1))throw failure('cli_invalid_argument');
  }
  private async invoke(args: string[], options: IncrementalCommandOptions = {}): Promise<{stdout:string;code:number|null}> {
    const timeoutMs=options.timeoutMs??this.options.timeoutMs??30000;
    if(!Number.isFinite(timeoutMs)||timeoutMs<=0)throw failure('cli_invalid_argument');
    if(this.closed||options.signal?.aborted)throw failure('cli_cancelled');
    const child=spawn(this.options.executable,args,{env:this.options.environment,shell:false,stdio:'pipe'});
    child.stdin.end();
    let done!:()=>void;
    this.active.set(child,new Promise<void>(resolve=>{done=resolve;}));
    try{return await new Promise((resolve,reject)=>{
      let error:IncrementalCliError|undefined;let bytes=0;const chunks:Buffer[]=[];
      const stop=(code:string)=>{error??=failure(code);chunks.length=0;child.kill('SIGKILL');};
      const abort=()=>stop('cli_cancelled');const timer=setTimeout(()=>stop('cli_timeout'),timeoutMs);
      options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
      child.stdout.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>(this.options.maxOutputBytes??4*1024*1024))stop('cli_output_limit');else if(!error)chunks.push(chunk);});
      child.stderr.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>(this.options.maxOutputBytes??4*1024*1024))stop('cli_output_limit');});
      child.on('error',(e:NodeJS.ErrnoException)=>{error=failure(e.code==='ENOENT'?'cli_not_found':'cli_command_failed');});
      child.once('close',code=>{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);if(error||this.closed)reject(error??failure('cli_cancelled'));else resolve({stdout:Buffer.concat(chunks).toString('utf8'),code});});
    });}finally{this.active.delete(child);done();}
  }
  private async json(args:string[],options:IncrementalCommandOptions={}) {
    const result=await this.invoke(args,options);
    if(result.code!==0)throw failure(commandErrorCode(result.stdout));
    try{const value=JSON.parse(result.stdout);if(value?.ok!==true||!value.data||typeof value.data!=='object')throw 0;return value.data as Record<string,any>;}catch{throw failure('cli_output_invalid');}
  }
  async sessionEventsFollow(options:{cursor?:string|null;scanLimit?:number;pollInterval?:string;signal?:AbortSignal}={}):Promise<IncrementalSessionStream>{
    if(this.closed||options.signal?.aborted)throw failure('cli_cancelled');
    const scanLimit=options.scanLimit??5000,pollInterval=options.pollInterval??'3s';
    if(!Number.isInteger(scanLimit)||scanLimit<1||scanLimit>5000||!/^\d+(?:\.\d+)?(?:ms|s|m)$/.test(pollInterval))throw failure('cli_invalid_argument');
    const args=['tail'];if(options.cursor!=null)args.push('--cursor',textValue(options.cursor));
    args.push('--mode','sessions','--scan-limit',String(scanLimit),'--poll-interval',pollInterval,'--include-media-paths','false','--follow','--jsonl','--strict-read-only');
    const child=spawn(this.options.executable,args,{env:this.options.environment,shell:false,stdio:'pipe'});child.stdin.end();
    const stream=new IncrementalSessionStream(child,{maxQueuedEvents:this.options.maxQueuedEvents??512,maxLineBytes:this.options.maxOutputBytes??1024*1024,signal:options.signal});
    this.active.set(child,stream.drained);this.streams.add(stream);void stream.drained.then(()=>{this.active.delete(child);this.streams.delete(stream);});
    return stream;
  }
  async tail(talker:string,options:IncrementalCommandOptions & {cursor?:string|null;sinceTime?:string;limit?:number;history?:boolean}={}):Promise<IncrementalTailResult> {
    talker=textValue(talker);
    if(options.cursor!=null&&options.sinceTime!==undefined||options.history&&options.sinceTime!==undefined)throw failure('cli_invalid_argument');
    if(options.limit!==undefined&&(!Number.isSafeInteger(options.limit)||options.limit<1)||options.history&&(options.limit===undefined||options.limit>1000))throw failure('cli_invalid_argument');
    const args=['tail',talker];if(options.history)args.push('--history');
    if(options.cursor!=null)args.push('--cursor',textValue(options.cursor));
    if(options.sinceTime!==undefined)args.push('--since-time',textValue(options.sinceTime));
    if(options.limit!==undefined)args.push('--limit',String(options.limit));
    args.push('--include-media-paths','false','--strict-read-only');
    const deadline=performance.now()+(options.timeoutMs??this.options.timeoutMs??30000);
    const result=await this.invoke(args,options);
    if(result.code!==0){
      if(exactMissingTable(result.stdout)){
        const remaining=deadline-performance.now();if(remaining<=0)throw failure('cli_timeout');
        const probe=await this.invoke(['sql',localHistorySql(talker),'--subdir','session','--file','session.db','--strict-read-only'],{signal:options.signal,timeoutMs:remaining});
        if(probe.code!==0)throw failure(commandErrorCode(probe.stdout));
        const state=localHistoryState(probe.stdout);
        if(state)return {events:[],cursor:null,last_local_id:null,event_count:0,non_text_count:0,freshness_confirmed:true,filtered_records:[],has_more:false,local_history_state:state};
      }
      throw failure(commandErrorCode(result.stdout));
    }
    const page=parseIncrementalTail(result.stdout,talker,{history:options.history});
    if(page.has_more&&page.cursor===(options.cursor??null))throw failure('cli_output_invalid');
    return page;
  }
  async resolveChat(query:string,options:IncrementalCommandOptions & {typeFilter?:'private'}={}) {
    query=textValue(query);const timeoutMs=options.timeoutMs??1000;
    if(timeoutMs>1000)throw failure('cli_invalid_argument');
    const args=['resolve-chat',query];if(options.typeFilter!==undefined){if(options.typeFilter!=='private')throw failure('cli_invalid_argument');args.push('--type-filter','private');}args.push('--strict-read-only');
    const data=await this.json(args,{...options,timeoutMs});
    if(!Array.isArray(data.candidates))throw failure('cli_output_invalid');
    const candidates=data.candidates.map((item:any)=>{
      if(!item||typeof item!=='object')throw failure('cli_output_invalid');
      return {username:textValue(item.username),display_name:textValue(typeof item.display_name==='string'&&!item.display_name.trim()?item.username:item.display_name),chat_type:textValue(item.chat_type)};
    });
    return {query,candidates};
  }
  async configuredAccount(options:IncrementalCommandOptions & {expectedAccount?:string}={}):Promise<string>{
    if(options.timeoutMs!==undefined&&(!Number.isFinite(options.timeoutMs)||options.timeoutMs<=0))throw failure('cli_invalid_argument');
    const deadline=options.timeoutMs===undefined?null:performance.now()+options.timeoutMs;
    const budget=(maximum:number)=>{const remaining=deadline===null?maximum:Math.min(maximum,deadline-performance.now());if(remaining<=0)throw failure('cli_timeout');return {signal:options.signal,timeoutMs:remaining};};
    const status=()=>this.json(['status','--include-debug','--strict-read-only'],budget(5000));
    const before=parseConfiguredWechatAccount(await status());
    if(options.expectedAccount!==undefined&&before!==options.expectedAccount)throw failure('cli_account_changed');
    return before;
  }
  async version(options:IncrementalCommandOptions={}):Promise<string>{const data=await this.json(['--version'],options);if(typeof data.version!=='string'||!data.version.trim())throw failure('cli_output_invalid');return data.version.trim();}
  async close():Promise<void>{this.closed=true;const pending=[...this.active.values(),...[...this.streams].map(stream=>stream.close())];for(const child of this.active.keys())child.kill('SIGKILL');await Promise.all(pending);this.streams.clear();}
}
