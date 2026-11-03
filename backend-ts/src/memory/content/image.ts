import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import {assertSourceEligibility} from '../../history/sqlite/source.ts';
import type {MemoryContentPlugin} from './registry.ts';
const imageMime=new Set(['image/png','image/jpeg','image/webp','image/gif']);
export const imageMemoryContent:MemoryContentPlugin={
 id:'notalone.image',version:'1',kinds:['image'],
 modelInputCost:identity=>({images:1,bytes:Number(identity.byteSize)}),
 snapshot(tx,{ownerId,contactId,message}){
  if(!tx.get("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='media_file'"))return null;
  const file=tx.get(`SELECT f.*,h.media_generation,a.record_id FROM media_file f
   JOIN message_media h ON h.owner_id=f.owner_id AND h.contact_id=f.contact_id AND h.message_id=f.message_id
   JOIN media_extraction_attempt a ON a.owner_id=f.owner_id AND a.id=f.produced_attempt_id
   WHERE f.owner_id=? AND f.contact_id=? AND f.message_id=? AND f.role='image_display'
   AND f.content_state='present' AND f.publish_state='current' AND f.container_valid=1 AND f.viewable=1
   AND h.state<>'cleared' ORDER BY f.created_at DESC,f.id LIMIT 1`,[ownerId,contactId,message.id]);
  if(!file||!imageMime.has(String(file.mime_type))||typeof file.content_digest!=='string'||!Number.isSafeInteger(Number(file.byte_size)))return null;
  try{assertSourceEligibility(tx,{owner_id:ownerId,contact_id:contactId,message_id:String(message.id),record_id:String(file.record_id)});}catch{return null;}
  return {fileId:String(file.id),sha256:file.content_digest,mediaGeneration:String(file.media_generation),mimeType:String(file.mime_type),byteSize:Number(file.byte_size)};
 },
 async prepare({ownerId:_,contactId,message,frozen,resources,signal,requireCurrent}){
  if(!resources)throw new StorageFailure('memory_content_plugin_unavailable');
  const ref=frozen.identity;
  const image=await resources.readImage({contactId,messageId:String(message.id),fileId:String(ref.fileId),sha256:String(ref.sha256),mediaGeneration:String(ref.mediaGeneration),mimeType:String(ref.mimeType),byteSize:Number(ref.byteSize),signal,requireCurrent});
  if(!imageMime.has(image.mimeType))throw new StorageFailure('memory_content_image_unsupported');
  const id=String(ref.fileId);
  return {message:{message_id:String(message.id),text:'[图片：实际内容随 image_id 提供]',sender:message.sender_role==='owner'?'self':'contact',
   occurred_at:message.sent_at===null?null:new Date(Number(message.sent_at)).toISOString(),text_representation:'image',content_kind:'image',
   image:{id,file_id:id,sha256:String(ref.sha256),mime_type:image.mimeType,media_generation:String(ref.mediaGeneration)}},
   images:[{id,mimeType:image.mimeType as 'image/png'|'image/jpeg'|'image/webp'|'image/gif',dataBase64:image.dataBase64}]};
 },
};
