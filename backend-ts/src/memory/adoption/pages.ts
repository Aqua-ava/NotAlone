import type {AdjudicationItem} from './contracts.ts';
import {sourceImageReference,type ContentSource} from '../content/evidence.ts';
import {MODEL_IMAGE_LIMITS} from '../../platform/models/image-normalization.ts';

export class AdjudicationInputError extends Error {
 readonly code='memory_adjudication_input_too_large';
 constructor(){super('memory_adjudication_input_too_large');this.name='AdjudicationInputError';}
}
function imageIds(sources:readonly ContentSource[]):Set<string>{
 const ids=new Set<string>();
 for(const source of sources){const image=sourceImageReference(source);if(image)ids.add(image.file_id);}
 return ids;
}

/** 比较页保留同一候选及来源快照，只划分有序旧记忆集合。 */
export function adjudicationPages(item:AdjudicationItem):AdjudicationItem[]{
 if(!item.similar.length)return [];
 const fixedImages=imageIds(item.candidate_source_texts),maxImages=MODEL_IMAGE_LIMITS.maxImagesPerMessage;
 if(fixedImages.size>maxImages)throw new AdjudicationInputError();
 const pages:AdjudicationItem[]=[];
 let similar:AdjudicationItem['similar']=[],images=new Set(fixedImages);
 for(const memory of item.similar){
  const nextImages=imageIds(memory.source_texts);
  let combined=new Set([...images,...nextImages]);
  if(similar.length===8||combined.size>maxImages){
   if(!similar.length)throw new AdjudicationInputError();
   pages.push({...item,similar});similar=[];combined=new Set([...fixedImages,...nextImages]);
  }
  if(combined.size>maxImages)throw new AdjudicationInputError();
  similar.push(memory);images=combined;
 }
 if(similar.length)pages.push({...item,similar});
 return pages;
}
