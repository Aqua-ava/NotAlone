import {constants} from 'node:fs';
import {open,statfs} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import {ManagedFiles} from '../../storage/sqlite/deletion/managed-files.ts';
import {sameManagedAddress} from '../../storage/sqlite/deletion/file-identity.ts';
import type {ManagedAddress} from '../../storage/sqlite/deletion/contracts.ts';

/** 只创建应用独立副本；无rename、链接或外部路径导入入口。 */
export class MediaFiles {
 readonly managed:ManagedFiles;
 private readonly root:string;
 constructor(userData:string){this.managed=new ManagedFiles(userData);this.managed.prepareArea('media');this.root=path.join(userData,'managed','media');}
 location(address:ManagedAddress):string {
  if(address.area!=='media'||address.kind!=='file'||!sameManagedAddress(this.managed.capture('media',address.locator),address))throw new StorageFailure('media_file_identity_changed');
  return path.join(this.root,address.locator);
 }
 async create(locator:string,identify:(address:ManagedAddress)=>Promise<void>,checkpoint:()=>Promise<void>,bytes:AsyncIterable<Uint8Array>,expected:{bytes:number;digest:string},validate:(location:string)=>Promise<unknown>):Promise<{address:ManagedAddress;bytes:number;digest:string;validation:unknown}> {
  if(!/^[a-f0-9-]{36}\.media$/.test(locator)||!Number.isSafeInteger(expected.bytes)||expected.bytes<1||!/^[a-f0-9]{64}$/.test(expected.digest))throw new StorageFailure('media_input_invalid');
  if(expected.bytes>32*1024*1024)throw new StorageFailure('media_resource_too_large');
  await checkpoint();this.managed.prepareArea('media');
  const disk=await statfs(this.root,{bigint:true});if(disk.bavail*disk.bsize<BigInt(expected.bytes)+1_048_576n)throw new StorageFailure('media_space_insufficient');
  let handle;let address:ManagedAddress|undefined;
  try{
   handle=await open(path.join(this.root,locator),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   address=this.managed.capture('media',locator);const stat=await handle.stat({bigint:true});
   if(String(stat.ino)!==address.identity.ino||stat.nlink!==1n)throw new StorageFailure('media_file_identity_changed');
   // identity持久成功前绝不写字节；崩溃窗口未知身份保持可见阻塞。
   await identify(address);
   const hash=createHash('sha256');let size=0;const iterator=bytes[Symbol.asyncIterator]();
   try{
    for(;;){await checkpoint();const next=await iterator.next();await checkpoint();if(next.done)break;
     const chunk=next.value;if(!(chunk instanceof Uint8Array)||chunk.byteLength>8*1024*1024||size+chunk.byteLength>expected.bytes)throw new StorageFailure('media_copy_incomplete');
     this.location(address);let offset=0;while(offset<chunk.byteLength){const written=await handle.write(chunk,offset,chunk.byteLength-offset,null);if(!written.bytesWritten)throw new StorageFailure('media_write_failed');offset+=written.bytesWritten;}
     size+=chunk.byteLength;hash.update(chunk);await checkpoint();
    }
   }finally{await iterator.return?.();}
   const digest=hash.digest('hex');if(size!==expected.bytes||digest!==expected.digest)throw new StorageFailure('media_copy_incomplete');
   await handle.sync();await handle.close();handle=undefined;
   const parent=await open(this.root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await parent.sync();}finally{await parent.close();}
   await checkpoint();const validation=await validate(this.location(address));await checkpoint();
   // 类型探针不能改变刚校验的副本；独立复读完整性。
   await this.verify(address,size,digest);await checkpoint();
   return {address,bytes:size,digest,validation};
  }catch(error){
   if((error as NodeJS.ErrnoException).code==='ENOSPC')throw new StorageFailure('media_space_insufficient');
   throw error instanceof StorageFailure?error:new StorageFailure('media_file_io_failed');
  }finally{await handle?.close();}
 }
 async verify(address:ManagedAddress,size:number,digest:string):Promise<void>{
  const handle=await open(this.location(address),constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const stat=await handle.stat({bigint:true});if(stat.nlink!==1n||String(stat.ino)!==address.identity.ino||stat.size!==BigInt(size))throw new StorageFailure('media_file_identity_changed');
   const hash=createHash('sha256');for await(const chunk of handle.createReadStream({autoClose:false}))hash.update(chunk);
   if(hash.digest('hex')!==digest)throw new StorageFailure('media_copy_incomplete');this.location(address);
  }finally{await handle.close();}
 }
 async preview(address:ManagedAddress,size:number,digest:string):Promise<Buffer>{
  if(!Number.isSafeInteger(size)||size>32*1024*1024)throw new StorageFailure('media_preview_too_large');
  await this.verify(address,size,digest);const handle=await open(this.location(address),constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const data=await handle.readFile();if(data.length!==size||createHash('sha256').update(data).digest('hex')!==digest)throw new StorageFailure('media_copy_incomplete');this.location(address);return data;}finally{await handle.close();}
 }
}
