import { tokenize } from './retrieval-lexical.ts';
export type EmbedTexts = (texts:readonly string[])=>Promise<readonly (readonly number[])[]>;
const terms=(text:string)=>tokenize(text).map(t=>t.text).filter(t=>Array.from(t).length>=2);
/** 只计算本次语料的BM25，不缓存正文或向量。 */
export function bm25Scores(query:string,texts:readonly string[]):number[] {return bm25Corpus(texts)(query);}
function bm25Corpus(texts:readonly string[]):(query:string)=>number[] {
 const docs=texts.map(text=>{const counts=new Map<string,number>();for(const term of terms(text))counts.set(term,(counts.get(term)??0)+1);return counts;});
 const lengths=docs.map(doc=>[...doc.values()].reduce((a,b)=>a+b,0));
 const average=lengths.reduce((a,b)=>a+b,0)/lengths.length||1;
 const frequency=new Map<string,number>();for(const doc of docs)for(const term of doc.keys())frequency.set(term,(frequency.get(term)??0)+1);
 return (query:string)=>{
 const queryTerms=new Set(terms(query));
 return docs.map((doc,i)=>{let result=0;for(const term of queryTerms){const count=doc.get(term)??0;if(!count)continue;const df=frequency.get(term)!;result+=Math.log(1+(docs.length-df+.5)/(df+.5))*count*2.2/(count+1.2*(.25+.75*lengths[i]/average));}return result;});
 };
}
/** embedding 端口必须为已准备的本地模型；失败直接向调用方传播。 */
export async function hybridCandidates<T extends {memory_id:string;text:string}>(texts:readonly string[],pool:readonly T[],embed:EmbedTexts,topK=5):Promise<T[][]> {
 if(!Number.isInteger(topK))throw new RangeError('召回预算无效。');
 if(!pool.length)return texts.map(()=>[]);
 const vectors=await embed([...texts,...pool.map(row=>row.text)]);
 if(vectors.length!==texts.length+pool.length||!vectors[0]?.length||vectors.some(v=>v.length!==vectors[0].length||v.some(x=>!Number.isFinite(x))))throw new Error('本机embedding输出不符合维度契约。');
 const norm=(v:readonly number[])=>Math.sqrt(v.reduce((sum,x)=>sum+x*x,0));
 const memories=vectors.slice(texts.length);
 const memoryNorms=memories.map(norm);
 const lexicalScores=bm25Corpus(pool.map(row=>row.text));
 const idCompare=(a:number,b:number)=>pool[a].memory_id<pool[b].memory_id?-1:pool[a].memory_id>pool[b].memory_id?1:0;
 return texts.map((text,q)=>{
  const lexical=lexicalScores(text).map((s,i)=>({s,i})).filter(row=>row.s>0);
  const queryNorm=norm(vectors[q]);
  const semantic=memories.map((v,i)=>{const denominator=queryNorm*memoryNorms[i];return {i,s:denominator?v.reduce((sum,x,j)=>sum+x*vectors[q][j],0)/denominator:0};});
  const scores=new Map<number,number>();
  for(const ranking of [semantic,lexical])ranking.sort((a,b)=>b.s-a.s||idCompare(a.i,b.i)).slice(0,topK).forEach(({i},rank)=>scores.set(i,(scores.get(i)??0)+1/(61+rank)));
  return [...scores.keys()].sort((a,b)=>scores.get(b)!-scores.get(a)!||idCompare(a,b)).slice(0,topK).map(i=>pool[i]);
 });
}
