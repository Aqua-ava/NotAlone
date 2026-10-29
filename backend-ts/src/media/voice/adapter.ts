import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import type {MediaAdapter,MediaExecution,MediaValidation} from '../sqlite/contracts.ts';
import type {VoiceResourcePort,VoiceDecoder} from './contracts.ts';
import {inspectSilk,inspectWav,pcmToWav,voiceLimits} from './format.ts';

const sha256 = (data:Uint8Array):string => createHash('sha256').update(data).digest('hex');
async function localBytes(location:string, maximum:number):Promise<Buffer> {
  const file = await open(location,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const before = await file.stat({bigint:true});
    if (!before.isFile() || before.nlink!==1n || before.size>BigInt(maximum)) throw new StorageFailure('voice_resource_limit');
    const data = Buffer.alloc(Number(before.size)); let offset=0;
    while (offset<data.length) {const read=await file.read(data,offset,data.length-offset,offset);if(!read.bytesRead)throw new StorageFailure('voice_file_changed');offset+=read.bytesRead;}
    const after=await file.stat({bigint:true});
    if (before.size!==after.size || before.mtimeNs!==after.mtimeNs || before.ctimeNs!==after.ctimeNs) throw new StorageFailure('voice_file_changed');
    return data;
  } finally {await file.close();}
}
const validation=(playable:boolean):MediaValidation=>({format:playable?'wav':'silk',mimeType:playable?'audio/wav':'audio/silk',containerValid:true,viewable:false,playable,imageQuality:'not_applicable',qualityProof:null});
export class VoiceMediaAdapter implements MediaAdapter {
  readonly version='voice-silk-wasm-3.7.1-v1';
  private readonly source:VoiceResourcePort|undefined;
  private readonly decoder:VoiceDecoder;
  constructor(options:{source?:VoiceResourcePort;decoder:VoiceDecoder}) {this.source=options.source;this.decoder=options.decoder;}
  supports(kind:string,goal:string):boolean {return kind==='voice'&&(goal==='audio_conversion'||goal==='extract'&&!!this.source);}
  async execute(context:MediaExecution) {
    await context.checkpoint();
    let silk:Buffer, parentFileId:string;
    let association=null;
    if (context.goal==='audio_conversion') {
      if (!context.input || context.source || context.token) throw new StorageFailure('voice_local_input_invalid');
      silk=await localBytes(context.input.localPath,voiceLimits.inputBytes); await context.checkpoint();inspectSilk(silk);parentFileId=context.input.fileId;
    } else {
      if (context.goal!=='extract'||!this.source||!context.source||!context.token) throw new StorageFailure('voice_source_unavailable');
      const resource=await this.source.read({contactId:context.contactId,messageId:context.messageId,source:context.source,token:context.token,signal:context.signal});await context.checkpoint();
      if (!Number.isSafeInteger(resource.expectedBytes)||resource.expectedBytes<1||resource.expectedBytes>voiceLimits.inputBytes||!/^[a-f0-9]{64}$/.test(resource.expectedSha256)) throw new StorageFailure('voice_copy_unproven');
      const chunks:Buffer[]=[];let size=0;const iterator=resource.bytes[Symbol.asyncIterator]();
      try {for(;;) {await context.checkpoint();const next=await iterator.next();await context.checkpoint();if(next.done)break;
        if (!(next.value instanceof Uint8Array)||size+next.value.byteLength>resource.expectedBytes) throw new StorageFailure('voice_copy_incomplete');
        size+=next.value.byteLength;chunks.push(Buffer.from(next.value));
      }} finally {await iterator.return?.();}
      silk=Buffer.concat(chunks,size);const proof=await resource.finish();await context.checkpoint();
      if(size!==resource.expectedBytes||sha256(silk)!==resource.expectedSha256)throw new StorageFailure('voice_copy_incomplete');
      if (proof.protocol!=='voice-complete-read-v1'||proof.complete!==true||proof.expectedBytes!==size||proof.association.recordId!==context.source.recordId||proof.association.messageId!==context.messageId) throw new StorageFailure('voice_copy_unproven');
      association=proof.association;inspectSilk(silk);
      parentFileId=(await this.save(context,silk,false)).fileId;
    }
    let wav:Buffer;
    try {
      const pcm=await this.decoder.decode(silk,context.signal);await context.checkpoint();
      if(pcm.byteLength>inspectSilk(silk).maximumPcmBytes)throw new StorageFailure('voice_pcm_invalid');
      wav=pcmToWav(pcm);
    } catch (error) {
      await context.checkpoint();
      if(context.goal==='audio_conversion')throw error instanceof StorageFailure?error:new StorageFailure('voice_decode_failed');
      return {association,errorCode:error instanceof StorageFailure?error.code:'voice_decode_failed'};
    }
    await this.save(context,wav,true,parentFileId);await context.checkpoint();return {association};
  }
  private save(context:MediaExecution,data:Buffer,playable:boolean,parentFileId?:string) {
    return context.save({role:playable?'audio_playback':'audio_source',parentFileId,expectedBytes:data.length,expectedSha256:sha256(data),
      bytes:(async function*(){for(let offset=0;offset<data.length;offset+=65536){await context.checkpoint();yield data.subarray(offset,offset+65536);}})(),
      validate:async location=>{const actual=await localBytes(location,playable?voiceLimits.pcmBytes+44:voiceLimits.inputBytes);await context.checkpoint();if(playable)inspectWav(actual);else inspectSilk(actual);return validation(playable);}});
  }
  close():Promise<void> {return this.decoder.close();}
}
