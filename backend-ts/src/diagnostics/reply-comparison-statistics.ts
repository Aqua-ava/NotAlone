/** 预注册回复对照：固定抽样算法，重复记录始终随所属case一起重采样。 */
export const REPLY_COMPARISON_BOOTSTRAP=Object.freeze({seed:102,resamples:10000,unit:'case',clusters:16,
 algorithm:'mulberry32-v1/paired-case-percentile-linear-r7'});
export interface PairedCaseValues {old:readonly number[];new:readonly number[]}
export type ComparisonStatistic='mean_difference'|'total_ratio'|'p50_ratio'|'p95_ratio';
function random(){let state=102;return ()=>{state=(state+0x6D2B79F5)|0;let value=state;value=Math.imul(value^(value>>>15),value|1);value^=value+Math.imul(value^(value>>>7),value|61);return ((value^(value>>>14))>>>0)/4294967296;};}
export function comparisonPairOrders():('AB'|'BA')[]{const next=random();return Array.from({length:48},()=>next()<0.5?'AB':'BA');}
function finite(value:number){if(!Number.isFinite(value))throw new Error('reply_comparison_invalid:statistical_overflow');return value;}
export const comparisonTotal=(values:readonly number[])=>finite(values.reduce((a,b)=>finite(a+b),0));
const mean=(values:readonly number[])=>finite(comparisonTotal(values)/values.length);
function quantile(values:readonly number[],p:number){const sorted=[...values].sort((a,b)=>a-b),position=(sorted.length-1)*p,lower=Math.floor(position);return sorted[lower]+(sorted[Math.ceil(position)]-sorted[lower])*(position-lower);}
function point(cases:readonly PairedCaseValues[],kind:ComparisonStatistic){
 const old=cases.flatMap(c=>[...c.old]),fresh=cases.flatMap(c=>[...c.new]);
 const value=(data:number[])=>kind==='mean_difference'?mean(data):kind==='total_ratio'?comparisonTotal(data):quantile(data,kind==='p50_ratio'?0.5:0.95);
 const baseline=value(old),candidate=value(fresh);
 return {baseline,candidate,estimate:kind==='mean_difference'?candidate-baseline:baseline===0?candidate===0?1:Infinity:finite(candidate/baseline)};
}
/** 零基线的非零新增用Infinity保留为失败，不能因不可计算而删除样本。 */
export function pairedCaseInterval(cases:readonly PairedCaseValues[],kind:ComparisonStatistic,sampling:'all_repeats'|'successful_observations'='all_repeats'){
 if(cases.length!==16||cases.some(c=>(sampling==='all_repeats'?(c.old.length!==3||c.new.length!==3):(c.old.length<1||c.old.length>3||c.new.length<1||c.new.length>3))||[...c.old,...c.new].some(v=>!Number.isFinite(v))))throw new Error('配对统计必须包含16case及已知观测；全样本各3次，成功延迟保留各臂1至3次。');
 const next=random(),samples:number[]=[];
 for(let i=0;i<10000;i++)samples.push(point(Array.from({length:16},()=>cases[Math.floor(next()*16)]),kind).estimate);
 // Infinity可能出现在零基线重采样中；该尾部不能插值为NaN或被静默过滤。
 samples.sort((a,b)=>a-b);
 const percentile=(p:number)=>{const index=(samples.length-1)*p,lo=samples[Math.floor(index)],hi=samples[Math.ceil(index)];return lo===hi?lo:!Number.isFinite(hi)?hi:lo+(hi-lo)*(index-Math.floor(index));};
 return {...point(cases,kind),ci95:[percentile(0.025),percentile(0.975)] as [number,number]};
}
