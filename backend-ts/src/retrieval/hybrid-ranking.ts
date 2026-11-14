/** 腾讯式双路名次融合：各路等权，分数不依赖 BM25 与余弦的量纲。 */
export const RRF_K=60;
export function reciprocalRankFusion<T>(lists:readonly (readonly T[])[],key:(item:T)=>string,limit=Infinity):{item:T;score:number}[]{
 const ranked=new Map<string,{item:T;score:number}>();
 for(const list of lists){
  const seen=new Set<string>();
  for(const [rank,item] of list.entries()){
   const id=key(item);if(seen.has(id))continue;seen.add(id);
   const score=1/(RRF_K+rank+1),prior=ranked.get(id);
   if(prior)prior.score+=score;else ranked.set(id,{item,score});
  }
 }
 return [...ranked.values()].sort((a,b)=>b.score-a.score||(key(a.item)<key(b.item)?-1:key(a.item)>key(b.item)?1:0)).slice(0,limit);
}
