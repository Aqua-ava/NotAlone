import sharp from 'sharp';

export interface ContactAvatar { mime_type: 'image/png'; base64: string }
export interface LocalContactAvatar { mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; dataBase64: string }
const maximumBytes = 256 * 1024;

/** 只规范化本机读取器提供的位图；本模块没有网络获取路径。 */
export async function normalizeContactAvatar(input: LocalContactAvatar, signal: AbortSignal): Promise<ContactAvatar | null> {
 try {
  signal.throwIfAborted();
  if(!['image/png','image/jpeg','image/gif','image/webp'].includes(input.mimeType)
   ||typeof input.dataBase64!=='string'||!input.dataBase64.length||input.dataBase64.length>Math.ceil(maximumBytes/3)*4
   ||input.dataBase64.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(input.dataBase64))return null;
  const bytes=Buffer.from(input.dataBase64,'base64');
  if(bytes.length>maximumBytes||bytes.toString('base64')!==input.dataBase64)return null;
  const decoder=sharp(bytes,{limitInputPixels:4_000_000,failOn:'error',page:0,pages:1});
  const format=(await decoder.metadata()).format;
  if(format!==({'image/png':'png','image/jpeg':'jpeg','image/gif':'gif','image/webp':'webp'} as const)[input.mimeType])return null;
  const image=await decoder.rotate().resize(96,96,{fit:'cover'}).png().toBuffer();
  signal.throwIfAborted();
  return image.length<=maximumBytes?{mime_type:'image/png',base64:image.toString('base64')}:null;
 }catch{return null;}
}
