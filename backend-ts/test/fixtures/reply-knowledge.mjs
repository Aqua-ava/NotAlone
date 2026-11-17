/** 领域验收显式展开全部按需条目；不作为候选生成或性能测量入口。 */
export function readKnowledge(reader,tx,scope){
 return [...readMemories(reader,tx,scope),...reader.readDocuments(tx,scope)];
}
export function readMemories(reader,tx,scope){return reader.list(tx,scope).flatMap(header=>{const item=reader.open(tx,scope,header);return item?[item]:[];});}
