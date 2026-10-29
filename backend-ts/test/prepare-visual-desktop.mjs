// 仅创建隔离合成App验收资料，不启动桌面、不读取微信或模型配置。
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fixture} from './media-support.mjs';
import {resourcePort,png} from './visual-media-support.mjs';
import {VisualMediaAdapter} from '../src/media/visual/adapter.ts';

const project=fileURLToPath(new URL('../../',import.meta.url));
execFileSync('bash',[join(project,'native/media-validation/build.sh')],{stdio:'pipe'});
const source=await mkdtemp(join(tmpdir(),'notalone-visual-desktop-source-'));
const cleanups=[];let f;
try {
  execFileSync('bash',[join(project,'native/media-validation/build-fixtures.sh'),source],{stdio:'pipe'});
  const options={data:png,quality:{kind:'thumbnail',proof:'synthetic-desktop-thumbnail-v1'}};
  f=await fixture({after:close=>cleanups.push(close)},new VisualMediaAdapter(resourcePort(options)));
  const image=f.messages.find(message=>message.kind==='image'),video=f.messages.find(message=>message.kind==='video');
  await f.media.extract(f.contact,image.id,{requestKey:randomUUID(),goal:'extract'});
  options.data=await readFile(join(source,'h264-aac.mp4'));
  await f.media.extract(f.contact,video.id,{requestKey:randomUUID(),goal:'extract'});
  await f.contacts.setReading(false);
  const databaseId=f.storage.status.databaseId;
  await f.media.close();await f.history.close();await f.contacts.close();await f.storage.close();
  await writeFile(join(f.root,'empty.env'),'# 合成媒体桌面验收，不配置模型或微信\n',{flag:'wx',mode:0o600});
  await writeFile(join(f.root,'sqlite-development.json'),JSON.stringify({formatVersion:1,intent:'open',role:'test',expectedDatabaseId:databaseId,capabilities:['contacts','history']}),{flag:'wx',mode:0o600});
  await writeFile(join(f.root,'backend-launch.json'),JSON.stringify({projectDirectory:project,envFilePath:join(f.root,'empty.env'),backendInfoPath:join(f.root,'managed/sqlite-backend.info')}),{flag:'wx',mode:0o600});
  const receipt={synthetic:true,userData:f.root,databaseId,ownerId:f.owner,contactId:f.contact,imageId:image.id,videoId:video.id,sourceIds:[...image.sourceRecordIds,...video.sourceRecordIds],reading:false};
  if(process.argv[2])await writeFile(resolve(process.argv[2]),JSON.stringify(receipt),{flag:'wx',mode:0o600});
  console.log(JSON.stringify(receipt));
} catch(error) {for(const close of cleanups.reverse())await close();throw error;}
finally {await rm(source,{recursive:true,force:true});}
