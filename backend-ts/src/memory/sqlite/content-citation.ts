import {StorageFailure,type StorageTransaction,type StorageRow} from '../../storage/sqlite/contracts.ts';
export interface ImageCitationReference {file_id:string;sha256:string;mime_type:string;media_generation:string}
/** 图片引用的是本次真正读取的受管副本，不能用另一版本补证。 */
export function requireImageCitation(tx:StorageTransaction,ownerId:string,contactId:string,messageId:string,value:unknown):ImageCitationReference{
 let ref:ImageCitationReference;
 try{ref=typeof value==='string'?JSON.parse(value):value as ImageCitationReference;}catch{throw new StorageFailure('memory_source_stale');}
 if(!ref||typeof ref.file_id!=='string'||!/^[0-9a-f-]{36}$/i.test(ref.file_id)||!/^[a-f0-9]{64}$/.test(ref.sha256)
  ||!['image/png','image/jpeg','image/webp','image/gif'].includes(ref.mime_type)||!/^\d+$/.test(ref.media_generation)
  ||!tx.get(`SELECT 1 FROM media_file f JOIN message_media h ON h.owner_id=f.owner_id AND h.message_id=f.message_id
   WHERE f.owner_id=? AND f.contact_id=? AND f.message_id=? AND f.id=? AND f.content_digest=? AND f.mime_type=?
   AND h.media_generation=? AND f.content_state='present' AND f.publish_state='current' AND f.viewable=1 AND f.container_valid=1`,
   [ownerId,contactId,messageId,ref.file_id,ref.sha256,ref.mime_type,BigInt(ref.media_generation)]))throw new StorageFailure('memory_source_stale');
 return ref;
}
export function citationContent(row:StorageRow):{contentKind:string;contentRef:ImageCitationReference|null}{
 const contentKind=typeof row.content_kind==='string'?row.content_kind:'text';
 if(contentKind==='text')return {contentKind,contentRef:null};
 try{return {contentKind,contentRef:JSON.parse(String(row.content_ref_json))};}catch{throw new StorageFailure('memory_source_stale');}
}
