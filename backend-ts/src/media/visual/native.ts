import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';

import type {VisualValidation} from "./contracts.ts";
export type {VisualValidation} from "./contracts.ts";
const errors=new Set(['media_format_unsupported','media_image_invalid','media_video_invalid','media_resource_too_large','media_resource_limit']);
/** 仅给受信任适配器校验已登记的受管副本；不接受HTTP或renderer提供的路径。 */
export function createVisualValidator(binaryPath:string) {
  return async (localPath:string,kind:'image'|'video',signal:AbortSignal):Promise<VisualValidation>=>{
    if(signal.aborted)throw new StorageFailure('media_interrupted');
    let handle;
    try {handle=await open(localPath,constants.O_RDONLY|constants.O_NOFOLLOW);} catch {throw new StorageFailure("media_file_io_failed");}
    try {
      const before=await handle.stat({bigint:true});
      if(!before.isFile()||before.nlink!==1n||before.size<1n)throw new StorageFailure('media_file_identity_changed');
      if(before.size>32n*1024n*1024n)throw new StorageFailure('media_resource_too_large');
      const result=await new Promise<VisualValidation>((resolve,reject)=>{
        const child=spawn(binaryPath,[kind],{stdio:['ignore','pipe','ignore',handle.fd],env:{PATH:'/usr/bin:/bin'}});
        let output=Buffer.alloc(0);let failed:string|null=null;
        const abort=()=>{failed='media_interrupted';child.kill('SIGKILL');};
        const timer=setTimeout(()=>{failed='media_validation_timeout';child.kill('SIGKILL');},10_000);
        signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
        child.stdout!.on('data',(data:Buffer)=>{if(output.length+data.length>4096){failed='media_validation_failed';child.kill('SIGKILL');}else output=Buffer.concat([output,data]);});
        child.once('error',()=>{failed='media_validator_unavailable';});
        child.once('close',code=>{
          clearTimeout(timer);signal.removeEventListener('abort',abort);
          if(failed){reject(new StorageFailure(failed));return;}
          try {
            const value=JSON.parse(output.toString('utf8'));
            if(code!==0||value.error){reject(new StorageFailure(errors.has(value.error)?value.error:'media_validation_failed'));return;}
            const formats=kind==='image'?new Map([['png','image/png'],['jpeg','image/jpeg'],['gif','image/gif'],['bmp','image/bmp']]):new Map([['mp4','video/mp4']]);
            if(formats.get(value.format)!==value.mimeType||value.containerValid!==true||value.viewable!==(kind==='image')||value.playable!==(kind==='video'))throw new Error();
            resolve({format:value.format,mimeType:value.mimeType,containerValid:true,viewable:value.viewable,playable:value.playable});
          } catch {reject(new StorageFailure('media_validation_failed'));}
        });
      });
      const after=await handle.stat({bigint:true});
      if(signal.aborted)throw new StorageFailure('media_interrupted');
      if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs||after.nlink!==1n)throw new StorageFailure('media_file_identity_changed');
      return result;
    } catch(error) {throw error instanceof StorageFailure?error:new StorageFailure("media_file_io_failed");} finally {await handle.close();}
  };
}
export const validateVisual=createVisualValidator(fileURLToPath(new URL('../../../../native/media-validation/.build/media-validation',import.meta.url)));
