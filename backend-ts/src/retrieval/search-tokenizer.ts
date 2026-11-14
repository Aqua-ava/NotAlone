import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
interface Segmenter {cutForSearch(text:string,hmm:boolean):string[]}
let segmenter:Segmenter|null|undefined;
const stopWords=new Set(['的','了','在','是','我','有','和','就','不','人','都','一','一个','上','也','很','到','说','要','去','你','会','着','没有','看','好','自己','这','他','她','它','们','那','吗','吧','呢','啊','呀','哦','嗯']);
function jieba():Segmenter|null{
 if(segmenter!==undefined)return segmenter;
 try{const {Jieba}=require('@node-rs/jieba'),{dict}=require('@node-rs/jieba/dict');segmenter=Jieba.withDict(dict);}
 catch{segmenter=null;}
 return segmenter!;
}
/** 写入和查询共享版本；原生分词不可用时只能使用同一套回退索引。 */
export function searchTokenizerFingerprint():string{return jieba()?'jieba-2.0.1-search-v1':'unicode-fts-v1';}
/** 索引保存分词表示，原始正文仍由业务资料提供。 */
export function indexText(text:string):string{return jieba()?.cutForSearch(text,true).join(' ')??text;}
/** 查询以 OR 匹配词项，排序交由 FTS5 BM25；不枚举所有单字、双字。 */
export function buildFtsQuery(query:string):string|null{
 const engine=jieba(),tokens=engine?engine.cutForSearch(query,true).map(token=>token.trim()).filter(token=>/[\p{L}\p{N}]/u.test(token)&&!stopWords.has(token)):query.match(/[\p{L}\p{N}_]+/gu)??[];
 const terms=[...new Set(tokens)].filter(Boolean);return terms.length?terms.map(token=>'"'+token.replaceAll('"','')+'"').join(' OR '):null;
}
