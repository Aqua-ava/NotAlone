import {createHash,createCipheriv} from 'node:crypto';
export const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
export function resourcePort(options={}) {
 return {open:async context=>{
  const data=options.data??png;
  return {association:{protocol:'media-association-v1',profileId:'synthetic-visual-v1',recordId:context.source.recordId,messageId:context.messageId,resourceIdentity:'synthetic-visual-resource'},
   authority:{...context.token,...options.authority},complete:options.complete??true,
   envelope:options.envelope??'plain',quality:options.quality??{kind:'thumbnail',proof:'synthetic-thumbnail-v1'},
   expectedBytes:options.expectedBytes??data.length,expectedSha256:options.expectedSha256??createHash('sha256').update(data).digest('hex'),
   bytes:(async function*(){yield data.subarray(0,20);await options.afterChunk?.(context);if(data.length>20)yield data.subarray(20);})(),
   withImageKey:options.withImageKey,close:async()=>{await options.onClose?.();options.closed?.();}};
 }};
}
export function datV4(bytes,{version=1,key=Buffer.from('cfcd208495d565ef'),aesSize=16,xorSize=0,xorKey=0}={}){
 const cipher=createCipheriv('aes-128-ecb',key,null),aes=Buffer.concat([cipher.update(bytes.subarray(0,aesSize)),cipher.final()]);
 const header=Buffer.from([7,8,0x56,0x30+version,8,7,0,0,0,0,0,0,0,0,0]);header.writeUInt32LE(aesSize,6);header.writeUInt32LE(xorSize,10);
 return Buffer.concat([header,aes,bytes.subarray(aesSize,bytes.length-xorSize),bytes.subarray(bytes.length-xorSize).map(v=>v^xorKey)]);
}
