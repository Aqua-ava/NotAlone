import {parentPort,workerData} from 'node:worker_threads';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import path from 'node:path';
// 固定本地包的CJS入口以保持其相邻silk.wasm离线定位；不接受URL或网络补资产。
let codec;
try {
  const require=createRequire(import.meta.url),main=require.resolve('silk-wasm');
  const expected=[['index.cjs','74bb76aba57b1b52787e1eace2870eaaab2deec32241e28f47a138c6b98de065'],['silk.wasm','88152af59af535b8056ac806710824b2259a361027451b494f175f48fb39c807']];
  for(const [name,digest] of expected)if(createHash('sha256').update(await readFile(path.join(path.dirname(main),name))).digest('hex')!==digest)throw Error();
  codec=await import('silk-wasm');
} catch {parentPort.postMessage({code:'voice_runtime_unavailable'});}
if(codec) {
  try {
    const {data}=await codec.decode(workerData.silk,24000);
    if(!(data instanceof Uint8Array)||!data.byteLength||data.byteLength%2||data.byteLength>workerData.maximum)throw Error();
    const pcm=Uint8Array.from(data);parentPort.postMessage({pcm},[pcm.buffer]);
  } catch {parentPort.postMessage({code:'voice_decode_failed'});}
}
