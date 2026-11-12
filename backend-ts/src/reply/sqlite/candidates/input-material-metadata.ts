import {decode} from '../requests.ts';

export interface InputMaterialMetadata {
 scopeKind?:'owner'|'contact';workspaceItem?:'request'|'draft'|'instruction'|'supplemental_context';
 qualification?:'confirmed'|'auto'|'unconfirmed'|'published';projectionKind?:'directory'|'profile'|'blocks';versionNo?:number;
}

/** 仅投影生成时已冻结的展示字段，不把完整来源身份传到页面。 */
export function inputMaterialMetadata(raw:string):InputMaterialMetadata{
 const identity=decode<Record<string,unknown>>(raw),projection=identity.projection as {kind?:unknown}|undefined;
 const versionNo=Number(identity.versionNo);
 return {
  ...(['owner','contact'].includes(String(identity.scopeKind))?{scopeKind:identity.scopeKind as InputMaterialMetadata['scopeKind']}:{}),
  ...(['request','draft','instruction','supplemental_context'].includes(String(identity.workspaceItem))?{workspaceItem:identity.workspaceItem as InputMaterialMetadata['workspaceItem']}:{}),
  ...(['confirmed','auto','unconfirmed','published'].includes(String(identity.qualification))?{qualification:identity.qualification as InputMaterialMetadata['qualification']}:{}),
  ...(['directory','profile','blocks'].includes(String(projection?.kind))?{projectionKind:projection!.kind as InputMaterialMetadata['projectionKind']}:{}),
  ...(Number.isSafeInteger(versionNo)&&versionNo>0?{versionNo}:{})};
}
