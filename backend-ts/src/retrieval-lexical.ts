import { casefold, normalizationBarriers } from './retrieval-casefold.ts';
export interface LexicalToken { text: string; weight: number }
export interface LexicalScore { score: number; matched_terms: string[] }
export const RELEVANCE_THRESHOLD = 0.15;
function normalize(text: string): string {
 if (typeof text !== 'string') throw new TypeError('词法评分文本必须是字符串。');
 let normalized='',run='';
 for(const c of text){if(normalizationBarriers.has(c)){normalized+=run.normalize('NFKC')+c;run='';}else run+=c;}
 normalized+=run.normalize('NFKC');
 return Array.from(normalized, c => casefold[c] ?? c).join('');
}
function normalizedTokens(text: string): LexicalToken[] {
 const result: LexicalToken[] = [];
 for (const match of text.matchAll(/([\u2e80-\u2eff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{3ffff}]+)|([a-z0-9\u00c0-\u024f]+)/gu)) {
  const run=Array.from(match[0]);
  if (match[1]) {
   for(const text of run)result.push({text,weight:0.5});
   for(let i=0;i<run.length-1;i++) result.push({text:run[i]+run[i+1],weight:1});
  } else result.push({text:match[0],weight:1});
 }
 return result;
}
export function tokenize(text:string):LexicalToken[] { return normalizedTokens(normalize(text)); }
export function buildQueryTokens(query:string):LexicalToken[] {
 const chars=Array.from(normalize(query));
 const sampled=chars.length>200 ? chars.slice(0,100).join('')+'\n'+chars.slice(-100).join('') : chars.join('');
 const seen=new Set<string>();
 return normalizedTokens(sampled).filter(t=>{if(seen.has(t.text))return false;seen.add(t.text);return true;});
}
export function scoreTokens(query:readonly LexicalToken[],text:string):LexicalScore {
 if(query.some(t=>!t.text || !Number.isFinite(t.weight) || t.weight<=0)) throw new TypeError('词法 token 无效。');
 if(!query.length)return {score:0,matched_terms:[]};
 const terms=new Set(tokenize(text).map(t=>t.text));
 const matched=query.filter(t=>terms.has(t.text));
 return {score:matched.reduce((sum,t)=>sum+t.weight,0)/query.reduce((sum,t)=>sum+t.weight,0),matched_terms:matched.map(t=>t.text)};
}
export function score(query:string,text:string):LexicalScore {return scoreTokens(buildQueryTokens(query),text);}
