/** 官方 working-directory 所需的纯虚拟目录；不接触宿主文件系统。 */
import {FileSystem,FsTargetKey,FsVersion,type FsTarget,type FsInfo} from '@deepseek-ai/dsh-fs';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';

export const skillWorkingDirectory='/notalone';
const target=Object.freeze({targetKey:FsTargetKey('notalone:virtual-directory'),displayPath:skillWorkingDirectory});
const deny=():never=>{throw new StorageFailure('discussion_files_forbidden');};
export class SkillDirectory extends FileSystem {
 async resolve(path:string,options?:{cwd?:string;signal?:AbortSignal}):Promise<FsTarget>{
  options?.signal?.throwIfAborted();if(path!==skillWorkingDirectory)deny();return target;
 }
 processPath(value:FsTarget):string{if(value.targetKey!==target.targetKey)deny();return skillWorkingDirectory;}
 async stat(value:FsTarget,signal?:AbortSignal):Promise<FsInfo>{signal?.throwIfAborted();this.processPath(value);return {type:'directory',version:FsVersion('notalone:virtual-directory-v1')};}
 fileUrl():never{return deny();}
 contains(parent:FsTarget,child:FsTarget):boolean{return parent.targetKey===target.targetKey&&child.targetKey===target.targetKey;}
 lstat():never{return deny();}
 readText():never{return deny();}
 streamText():never{return deny();}
 readBytes():never{return deny();}
 readByteRange():never{return deny();}
 listDir():never{return deny();}
 writeText():never{return deny();}
 editText():never{return deny();}
}
