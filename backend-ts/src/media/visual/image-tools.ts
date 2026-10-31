import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import {userInfo} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {NarrowWechatClientOptions} from '../../history/wechat/native-client.ts';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';

export interface ImageRuntimeKey {accountKey:string;rootSha256:string;aesKey:Uint8Array;xorKey:number}
interface ProviderOptions {configPath:string;keyTool:string}
const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const userHome=userInfo().homedir;
const decoder=fileURLToPath(new URL('../../../../native/media-validation/.build/media-validation',import.meta.url));

async function regular(file:string,maximum:number,executable=false):Promise<Buffer> {
 if(!path.isAbsolute(file)||path.normalize(file)!==file||await realpath(file)!==file)throw new Error('image_tool_invalid');
 const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try {
  const before=await handle.stat({bigint:true});
  if(!before.isFile()||before.size<1n||before.size>BigInt(maximum)||(before.mode&0o022n)!==0n||executable&&(before.mode&0o111n)===0n)throw new Error('image_tool_invalid');
  const data=await handle.readFile(),after=await handle.stat({bigint:true}),current=await lstat(file,{bigint:true});
  if(before.dev!==current.dev||before.ino!==current.ino||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs||BigInt(data.length)!==before.size)throw new Error('image_tool_changed');
  return data;
 }finally{await handle.close();}
}

/** 图片专用外置工具只从宿主选定路径装配，不继承模型凭据或 renderer 输入。 */
export async function enrichImageToolOptions(options:NarrowWechatClientOptions):Promise<NarrowWechatClientOptions> {
 const environment:Record<string,string|undefined>=options.environment?{...options.environment}:Object.fromEntries(
  ['HOME','PATH','TMPDIR','LANG','LC_ALL'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]));
 if(!options.environment&&process.env.NOTALONE_WECHAT_CONFIG)environment.WECHAT_CLI_CONFIG=process.env.NOTALONE_WECHAT_CONFIG;
 try {
  const bytes=await regular(decoder,32*1024*1024,true);
  environment.NOTALONE_IMAGE_DECODER=decoder;environment.NOTALONE_IMAGE_DECODER_SHA256=sha(bytes);
 }catch{/* 普通图片仍可提取；WXGF 明确报告解码组件不可用。 */}
 return {...options,environment,imageKeyChannel:true};
}

function aes(value:unknown):Buffer|null {
 if(typeof value!=='string')return null;
 const text=value.trim();
 if(/^[a-fA-F0-9]{32}$/.test(text))return Buffer.from(text,'hex');
 return Buffer.byteLength(text)===16?Buffer.from(text):null;
}
async function imageConfig(file:string,accountKey:string) {
 const bytes=await regular(file,1024*1024);
 try {
  const value=JSON.parse(bytes.toString('utf8'));
  if(value.wxid!==accountKey||typeof value.db_root!=='string'||!path.isAbsolute(value.db_root))throw new Error('image_account_mismatch');
  const root=await realpath(value.db_root);
  return {root,rootSha256:sha(root),fingerprint:sha(bytes),configuredKey:aes(value.image_key),xorKey:value.image_xor_key};
 }finally{bytes.fill(0);}
}

/** 仅在已认证原图明确缺钥后调用；同账号密钥只保留于本宿主内存。 */
export function createImageRuntimeKeyProvider(options:ProviderOptions) {
 const cached=new Map<string,Promise<ImageRuntimeKey|null>>();
 return {
  async prepare(accountKey:string,signal:AbortSignal):Promise<ImageRuntimeKey|null>{
   if(signal.aborted)throw new StorageFailure('media_interrupted');
   let config;
   try{config=await imageConfig(options.configPath,accountKey);}catch{return null;}
   const cacheKey=accountKey+'\0'+config.rootSha256+'\0'+config.fingerprint;
   let pending=cached.get(cacheKey);
   if(!pending){
    pending=(async()=>{
     if(config.configuredKey&&Number.isInteger(config.xorKey)&&config.xorKey>=0&&config.xorKey<=255)
      return {accountKey,rootSha256:config.rootSha256,aesKey:config.configuredKey,xorKey:config.xorKey};
     config.configuredKey?.fill(0);
     let stdout:Buffer|undefined,stderr:Buffer|undefined;
     try {
      const tool=await regular(options.keyTool,32*1024*1024,true),toolDigest=sha(tool);
      const output=await new Promise<{stdout:Buffer;stderr:Buffer}>((resolve,reject)=>{
       execFile(options.keyTool,['image-key','--quiet','--root',config.root],{encoding:'buffer',maxBuffer:64*1024,timeout:8_000,signal,
        env:{...Object.fromEntries(['PATH','TMPDIR','LANG','LC_ALL'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]])),HOME:userHome}},
        (error,out,err)=>error?(out.fill(0),err.fill(0),reject(new Error('image_key_unavailable'))):resolve({stdout:out,stderr:err}));
      });
      stdout=output.stdout;stderr=output.stderr;
      const start=stdout.indexOf(123);if(start<0)return null;
      const value=JSON.parse(stdout.subarray(start).toString('utf8'));
      const key=aes(value.image_key?.key),xor=value.image_key?.xor_key??0x37;
      // 未报告 XOR 时沿用上游格式默认值；最终长度／MD5 校验仍必须逐图通过。
      if(!key||!Number.isInteger(xor)||xor<0||xor>255){key?.fill(0);return null;}
      const current=await imageConfig(options.configPath,accountKey);current.configuredKey?.fill(0);
      const reportedRoot=typeof value.scan_root==='string'?await realpath(value.scan_root):config.root;
      if(current.fingerprint!==config.fingerprint||current.root!==config.root||reportedRoot!==config.root||
       value.wxid!==undefined&&value.wxid!==accountKey||sha(await regular(options.keyTool,32*1024*1024,true))!==toolDigest){key.fill(0);return null;}
      return {accountKey,rootSha256:config.rootSha256,aesKey:key,xorKey:xor};
     }catch{return null;}finally{stdout?.fill(0);stderr?.fill(0);}
    })();
    cached.set(cacheKey,pending);
   }else config.configuredKey?.fill(0);
   const result=await pending;
   if(signal.aborted)throw new StorageFailure('media_interrupted');
   return result?{...result,aesKey:Uint8Array.from(result.aesKey)}:null;
  },
  async clear():Promise<void>{const values=[...cached.values()];cached.clear();for(const result of await Promise.all(values))result?.aesKey.fill(0);},
 };
}

const providers=new Map<string,ReturnType<typeof createImageRuntimeKeyProvider>>();
export async function prepareImageRuntimeKey(executable:string,accountKey:string,signal:AbortSignal):Promise<ImageRuntimeKey|null> {
 const configPath=process.env.NOTALONE_WECHAT_CONFIG??path.join(userHome,'.config/wxcli/config.json');
 const candidates=process.env.NOTALONE_WECHAT_IMAGE_KEY_TOOL?[process.env.NOTALONE_WECHAT_IMAGE_KEY_TOOL]:[
  path.join(path.dirname(executable),'wxkey'),path.join(userHome,'Library/Application Support/NotAloneDesktop/wechat-tool/bin/wxkey'),path.join(userHome,'.local/share/wechat-cli/wxkey')];
 let tool:string|undefined;
 for(const candidate of candidates){try{await regular(candidate,32*1024*1024,true);tool=candidate;break;}catch{/* 只检查固定外置安装位置。 */}}
 if(!tool)return null;
 const key=configPath+'\0'+tool;
 let provider=providers.get(key);if(!provider){provider=createImageRuntimeKeyProvider({configPath,keyTool:tool});providers.set(key,provider);}
 return provider.prepare(accountKey,signal);
}
export async function clearImageRuntimeKeys():Promise<void>{const selected=[...providers.values()];providers.clear();await Promise.all(selected.map(provider=>provider.clear()));}
