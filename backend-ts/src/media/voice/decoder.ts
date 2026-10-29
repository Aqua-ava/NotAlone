import {Worker} from 'node:worker_threads';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import type {VoiceDecoder} from './contracts.ts';
import {inspectSilk,voiceLimits} from './format.ts';

/** 每次显式转换使用独立Worker；退出/取消以terminate完成为释放边界。 */
export class SilkWasmDecoder implements VoiceDecoder {
  private readonly running = new Set<{worker:Worker;stop:()=>void;done:Promise<void>}>();
  private closed=false;
  async decode(silk:Uint8Array,signal:AbortSignal):Promise<Uint8Array> {
    const maximum=inspectSilk(silk).maximumPcmBytes;
    if(this.closed||signal.aborted)throw new StorageFailure('voice_conversion_cancelled');
    const worker=new Worker(new URL('./decoder-worker.mjs',import.meta.url),{workerData:{silk:Uint8Array.from(silk),maximum},stdout:true,stderr:true,resourceLimits:{maxOldGenerationSizeMb:48,maxYoungGenerationSizeMb:8,stackSizeMb:2}});
    worker.stdout?.resume();worker.stderr?.resume();
    let finish!:()=>void;const done=new Promise<void>(resolve=>{finish=resolve;});let stop!:()=>void;
    let timer:NodeJS.Timeout|undefined;
    const result=new Promise<Uint8Array>((resolve,reject)=>{
      let settled=false;
      const settle=(value?:Uint8Array,code?:string)=>{if(settled)return;settled=true;clearTimeout(timer);if(code)reject(new StorageFailure(code));else resolve(value!);};
      stop=()=>settle(undefined,'voice_conversion_cancelled');
      signal.addEventListener('abort',stop,{once:true});
      timer=setTimeout(()=>settle(undefined,'voice_conversion_timeout'),voiceLimits.wallMs);
      worker.once('message',message=>{
        if(message?.pcm instanceof Uint8Array&&message.pcm.byteLength>0&&message.pcm.byteLength%2===0&&message.pcm.byteLength<=maximum)settle(message.pcm);
        else settle(undefined,message?.code==='voice_runtime_unavailable'?'voice_runtime_unavailable':'voice_decode_failed');
      });
      worker.once('error',()=>settle(undefined,'voice_decode_failed'));
      worker.once('exit',()=>settle(undefined,'voice_decode_failed'));
    });
    const entry={worker,stop,done};this.running.add(entry);
    try {return await result;} finally {
      clearTimeout(timer);signal.removeEventListener('abort',stop);
      try{await worker.terminate();}finally{this.running.delete(entry);finish();}
    }
  }
  async close():Promise<void> {this.closed=true;const entries=[...this.running];for(const entry of entries)entry.stop();await Promise.all(entries.map(e=>e.done));}
}
