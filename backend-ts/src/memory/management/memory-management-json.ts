/** 保留Python顶层修订号的int合同，同时沿宿主无损JSON保留bigint。 */
import {parseJson} from '../../host/host-json.ts';
export function parseMemoryManagementJSON(text:string,integerRevision=false):unknown {
  if(integerRevision){
    const invalidParents=new WeakSet<object>();
    const root=JSON.parse(text,function(key:string,value:unknown,context?:{source?:string}){
      if(key==='expected_revision'&&typeof value==='number'&&context?.source&&!/^-?\d+$/.test(context.source))invalidParents.add(this);
      return value;
    });
    if(root&&typeof root==='object'&&invalidParents.has(root))throw new TypeError('revision_integer_required');
  }
  return parseJson(text);
}
