import {imageMemoryContent} from '../../../src/memory/content/image.ts';
import {imageContentReference} from '../../../src/memory/content/evidence.ts';

/** 仅验证第三种来源类型的实际视觉输入和资源删除，不开放真实视频解析。 */
export const visualMemoryContent={
 id:'synthetic.visual',version:'1',kinds:['video'],
 modelInputCost:identity=>imageMemoryContent.modelInputCost(identity.asset),
 managedFiles:identity=>[identity.asset.fileId],
 snapshot(tx,{ownerId,contactId,message}){
  const file=tx.get(`SELECT f.*,h.media_generation FROM media_file f JOIN message_media h
   ON h.owner_id=f.owner_id AND h.contact_id=f.contact_id AND h.message_id=f.message_id
   WHERE f.owner_id=? AND f.contact_id=? AND f.message_id=? AND f.role='video_playback'
   AND f.content_state='present' AND f.publish_state='current' AND f.viewable=1 AND h.state<>'cleared'`,[ownerId,contactId,message.id]);
  return file?{asset:{fileId:String(file.id),sha256:String(file.content_digest),mediaGeneration:String(file.media_generation),mimeType:String(file.mime_type),byteSize:Number(file.byte_size)}}:null;
 },
 evidence(_tx,{frozen}){const ref=frozen.identity.asset;return {representation:'image',reference:imageContentReference({file_id:ref.fileId,sha256:ref.sha256,mime_type:ref.mimeType,media_generation:ref.mediaGeneration})};},
 async prepare(input){
  const result=await imageMemoryContent.prepare({...input,frozen:{...input.frozen,identity:input.frozen.identity.asset}});
  return {...result,message:{...result.message,content_kind:'video'}};
 },
};
