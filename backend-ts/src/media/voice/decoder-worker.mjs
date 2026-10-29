import {parentPort,workerData} from 'node:worker_threads';
// 固定本地包的CJS入口以保持其相邻silk.wasm离线定位；不接受URL或网络补资产。
let codec;
try {codec=await import('silk-wasm');} catch {parentPort.postMessage({code:'voice_runtime_unavailable'});}
if(codec) {
  try {
    const {data}=await codec.decode(workerData.silk,24000);
    if(!(data instanceof Uint8Array)||!data.byteLength||data.byteLength%2||data.byteLength>workerData.maximum)throw Error();
    const pcm=Uint8Array.from(data);parentPort.postMessage({pcm},[pcm.buffer]);
  } catch {parentPort.postMessage({code:'voice_decode_failed'});}
}
