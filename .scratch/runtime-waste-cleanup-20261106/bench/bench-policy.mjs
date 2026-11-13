// 测量 createExtractionPolicyVersion 首次捕获与 assertCurrent 的耗时（只读源码树，无私人资料）。
// 用法：node bench/bench-policy.mjs
const {createExtractionPolicyVersion}=await import(new URL('../../../backend-ts/src/memory/extraction/policy-version.ts',import.meta.url).href);
let t=performance.now();
const v=await createExtractionPolicyVersion();
console.log('first capture ms',(performance.now()-t).toFixed(1));
const N=20;t=performance.now();
for(let i=0;i<N;i++)await v.assertCurrent();
console.log('assertCurrent avg ms',((performance.now()-t)/N).toFixed(1));
