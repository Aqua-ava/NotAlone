import {StorageFailure} from '../storage/sqlite/contracts.ts';

/** 模型地址写入受控环境文件前统一规范化；不接受凭据、查询参数或可注入环境行的字符。 */
export function normalizeModelBaseUrl(value:unknown):string {
 const invalid=()=>new StorageFailure('setup_request_invalid');
 if(typeof value!=='string'||!value||value.length>2048||/[\s\u0000-\u001f\u007f-\u009f"'\\?#]/u.test(value)||!/^https?:\/\//i.test(value))throw invalid();
 let url:URL;try{url=new URL(value);}catch{throw invalid();}
 if(!url.hostname||url.username||url.password||url.search||url.hash||value.slice(value.indexOf('://')+3).split('/')[0].includes('@')
  ||url.protocol!=='https:'&&(url.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw invalid();
 return url.toString().replace(/\/+$/,'');
}
