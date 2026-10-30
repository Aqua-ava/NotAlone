import {createDecipheriv} from 'node:crypto';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';

export const MAX_VISUAL_BYTES = 32 * 1024 * 1024;
const signatures = [Buffer.from([255,216,255]), Buffer.from([137,80,78,71]),
  Buffer.from('GIF8'), Buffer.from('BM'), Buffer.from([73,73,42,0])];
const v1 = Buffer.from([7,8,86,49,8,7]), v2 = Buffer.from([7,8,86,50,8,7]);
const fixedKey = Buffer.from('cfcd208495d565ef');
export interface DatKey {aesKey?: Uint8Array; xorKey?: number}
function bounded(data:Uint8Array):Buffer {
  if (!data.length || data.length > MAX_VISUAL_BYTES) throw new StorageFailure('media_resource_too_large');
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}
function recognized(data:Buffer):boolean {return signatures.some(header=>data.subarray(0,header.length).equals(header));}

/** 纯字节候选转换。格式头不证明可查看性、资源完整性或原图质量。 */
export function decodeWechatDat(input:Uint8Array, key:DatKey = {}):Buffer {
  const data=bounded(input);
  if(data.subarray(0,4).toString('ascii').toLowerCase()==='wxgf')throw new StorageFailure('unsupported');
  const isV1=data.subarray(0,6).equals(v1),isV2=data.subarray(0,6).equals(v2);
  if (isV1 || isV2) {
    if (data.length<15) throw new StorageFailure('image_dat_invalid');
    // 仅接受已核验的头变体，保留字节的其他值没有支持证据。
    if(data[14]!==0)throw new StorageFailure('unsupported');
    const aesSize=data.readUInt32LE(6),xorSize=data.readUInt32LE(10);
    const aligned=aesSize ? aesSize+(16-aesSize%16) : 0;
    if (aligned>data.length-15 || xorSize>data.length-15-aligned) throw new StorageFailure('image_dat_invalid');
    if (isV2 && (!key.aesKey || key.aesKey.length!==16)) throw new StorageFailure('needs_image_key');
    if (xorSize && (!Number.isInteger(key.xorKey) || key.xorKey!<0 || key.xorKey!>255)) throw new StorageFailure('needs_image_key');
    let decrypted=Buffer.alloc(0);
    try {
      if(aligned){
        const decipher=createDecipheriv('aes-128-ecb',isV1?fixedKey:key.aesKey!,null);
        decrypted=Buffer.concat([decipher.update(data.subarray(15,15+aligned)),decipher.final()]);
      }
      if(decrypted.length!==aesSize)throw new Error();
    } catch {throw new StorageFailure(isV2?'needs_image_key':'image_dat_invalid');}
    const tailStart=data.length-xorSize;
    const tail=Buffer.from(data.subarray(tailStart).map(byte=>byte^(key.xorKey??0)));
    const output=Buffer.concat([decrypted,data.subarray(15+aligned,tailStart),tail]);
    if(output.subarray(0,4).toString('ascii').toLowerCase()==='wxgf')throw new StorageFailure('unsupported');
    if(!recognized(output))throw new StorageFailure(isV2?'needs_image_key':'unsupported');
    return output;
  }
  if(data[0]===7&&data[1]===8&&data[2]===86)throw new StorageFailure('unsupported');
  for (const header of signatures) {
    const xor=data[0]!^header[0]!;
    if (data.length>=header.length && header.every((byte,index)=>(data[index]!^xor)===byte)) {
      return Buffer.from(data.map(byte=>byte^xor));
    }
  }
  throw new StorageFailure('unsupported');
}
