import type {MediaAdapter} from '../sqlite/contracts.ts';
import type {VoiceResourcePort} from './contracts.ts';
import {VoiceMediaAdapter} from './adapter.ts';
import {SilkWasmDecoder} from './decoder.ts';

/** 默认仅启用受管原件本地重转；真实提取须另装已认证资源端口。 */
export function createVoiceMediaAdapter(source?:VoiceResourcePort):MediaAdapter {
  return new VoiceMediaAdapter({source,decoder:new SilkWasmDecoder()});
}
