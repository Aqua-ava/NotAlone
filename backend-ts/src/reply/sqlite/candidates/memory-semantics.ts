import type {EmbedTexts} from '../../../retrieval/retrieval-hybrid.ts';
/** 稠密（语义余弦）与稀疏（词法覆盖率）的综合分权重：稠密为主、稀疏为辅；ADR-182。 */
export const DENSE_WEIGHT=0.8;
export const SPARSE_WEIGHT=0.2;
/** 综合分门槛：低于它的记忆不进入回复。标定依据见 ADR-182。 */
export const HYBRID_THRESHOLD=0.48;
/** 语义检索词上限；超过时取头尾各半，避免超出本机模型输入长度。 */
const MAX_SEMANTIC_QUERY_CHARS=400;
const EMBED_TIMEOUT_MS=8000;
export interface SemanticMemory {id:string;versionNo:bigint|string;text:string}
/** 单次请求的语义得分：仅在检索词一致时才可使用；不持久化。 */
export interface SemanticScores {query:string;scores:Record<string,number>}
export const semanticKey=(id:string,versionNo:bigint|string)=>`${id}:${versionNo}`;
const clip=(text:string)=>{const chars=Array.from(text);return chars.length<=MAX_SEMANTIC_QUERY_CHARS?text:chars.slice(0,MAX_SEMANTIC_QUERY_CHARS/2).join('')+chars.slice(-MAX_SEMANTIC_QUERY_CHARS/2).join('');};
/** 在事务外计算检索词与记忆池的余弦相似度；模型不可用或超时返回 null，调用方退回词法路径。 */
export async function scoreMemorySemantics(query:string,pool:readonly SemanticMemory[],embed:EmbedTexts,signal?:AbortSignal):Promise<SemanticScores|null>{
 if(!query.trim()||!pool.length)return null;
 try{
  const timeout=AbortSignal.timeout(EMBED_TIMEOUT_MS),stop=signal?AbortSignal.any([signal,timeout]):timeout;
  const vectors=await Promise.race([embed([clip(query),...pool.map(item=>item.text)]),new Promise<never>((_,reject)=>stop.addEventListener('abort',()=>reject(stop.reason),{once:true}))]);
  signal?.throwIfAborted();
  if(vectors.length!==pool.length+1||!vectors[0]?.length||vectors.some(v=>v.length!==vectors[0].length||v.some(x=>!Number.isFinite(x))))return null;
  const norm=(v:readonly number[])=>Math.sqrt(v.reduce((sum,x)=>sum+x*x,0)),q=vectors[0],qn=norm(q),scores:Record<string,number>={};
  pool.forEach((item,index)=>{const v=vectors[index+1],d=qn*norm(v);scores[semanticKey(item.id,item.versionNo)]=d?v.reduce((sum,x,j)=>sum+x*q[j],0)/d:0;});
  return {query,scores};
 }catch(error){if(signal?.aborted)throw error;return null;}
}
/** 事务内校验传入得分的形状；不合法一律忽略。 */
export function readSemanticScores(value:unknown,query:string):ReadonlyMap<string,number>|undefined{
 if(!value||typeof value!=='object')return undefined;
 const v=value as Record<string,unknown>;
 if(v.query!==query||!v.scores||typeof v.scores!=='object'||Array.isArray(v.scores))return undefined;
 const map=new Map<string,number>();
 for(const [key,score] of Object.entries(v.scores as Record<string,unknown>)){if(typeof score!=='number'||!Number.isFinite(score))return undefined;map.set(key,score);}
 return map;
}
