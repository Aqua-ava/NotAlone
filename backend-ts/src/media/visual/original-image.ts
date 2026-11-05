import type {MediaAdapter,MediaExecution,MediaGoal,MediaKind} from '../sqlite/contracts.ts';
import type {VisualResourcePort,VisualValidator} from './contracts.ts';
import {VisualMediaAdapter} from './adapter.ts';
import {clearImageRuntimeKeys} from './image-tools.ts';

/** 正常图片提取只要求来源关联、完整读取和实际可查看解码；资源端口不返回缩略图，保存的一律是标准图或高清图。 */
export class OriginalImageMediaAdapter implements MediaAdapter {
 readonly version='chat-image-v3';
 readonly #visual:VisualMediaAdapter;
 constructor(resources:VisualResourcePort,validate?:VisualValidator){this.#visual=new VisualMediaAdapter(resources,validate);}
 supports(kind:MediaKind,goal:MediaGoal):boolean{return kind==='image'&&goal==='extract';}
 execute(context:MediaExecution){return this.#visual.execute(context);}
 async close(){await this.#visual.close();await clearImageRuntimeKeys();}
}
