import { buildQueryTokens, scoreTokens, type LexicalToken } from './retrieval-lexical.ts';
/** 仅接收调用方已按范围、来源、有效期过滤的资料；不授予读取权限。 */
export interface RetrievalMemory {
 memory_id?: string; candidate_id?: string; text:string; confidence:number;
 adoption_method?:string; valid_at:string|null; relevance_score?:number|null; matched_terms?:string[];
}
const id=(row:RetrievalMemory)=>row.candidate_id??row.memory_id??'';
const compareText=(a:string,b:string)=>a<b?-1:a>b?1:0;
function instant(value:string):bigint {
 const match=value.match(/\.(\d+)(?=Z$|[+-]\d{2}:\d{2}$)/);
 const millis=Date.parse(value);
 if(!Number.isFinite(millis))throw new TypeError('记忆时间无效。');
 return BigInt(millis)*1000n+BigInt((match?.[1]??'').padEnd(6,'0').slice(3,6));
}
function compare(a:RetrievalMemory,b:RetrievalMemory):number {
 const score=(b.relevance_score??0)-(a.relevance_score??0);if(score)return score;
 const manual=(r:RetrievalMemory)=>!r.candidate_id&&r.adoption_method==='manual'?1:0;
 const adoption=manual(b)-manual(a);if(adoption)return adoption;
 const confidence=b.confidence-a.confidence;if(confidence)return confidence;
 if(a.valid_at===null&&b.valid_at!==null)return 1;
 if(b.valid_at===null&&a.valid_at!==null)return -1;
 if(a.valid_at!==null&&b.valid_at!==null){const x=instant(a.valid_at),y=instant(b.valid_at);if(x!==y)return x>y?-1:1;}
 return compareText(id(a),id(b));
}
export function rankMemories<T extends RetrievalMemory>(rows:readonly T[],query:readonly LexicalToken[],limit:number):(T&{relevance_score:number;matched_terms:string[]})[] {
 if(!Number.isInteger(limit)||limit<1)throw new RangeError('关系记忆排序预算无效。');
 return rows.map(row=>{const result=scoreTokens(query,row.text);return {...row,relevance_score:result.score,matched_terms:result.matched_terms};}).sort(compare).slice(0,limit);
}
export function recallMemories<T extends RetrievalMemory>(rows:readonly T[],query:string|null,limit:number):T[] {
 if(query===null)return rows.slice(0,limit);
 const tokens=buildQueryTokens(query);return tokens.length?rankMemories(rows,tokens,limit):[];
}
export function mergeMemoryRecalls<T extends RetrievalMemory>(recalls:readonly (readonly T[])[]):T[] {
 if(recalls.length===1)return [...recalls[0]];
 const merged=new Map<string,T>();
 for(const rows of recalls)for(const row of rows){const previous=merged.get(id(row));if(!previous||(row.relevance_score??0)>(previous.relevance_score??0))merged.set(id(row),row);}
 return [...merged.values()].sort(compare);
}
