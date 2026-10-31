import type {MediaAdapter,MediaExecution,MediaGoal,MediaKind} from '../sqlite/contracts.ts';
import type {VisualResourcePort,VisualValidator} from './contracts.ts';
import {VisualMediaAdapter} from './adapter.ts';

/** 正常图片同步与手动重试统一只取原图；保留通用视觉适配器的既有独立合同。 */
export class OriginalImageMediaAdapter implements MediaAdapter {
 readonly version='original-image-v1';
 readonly #visual:VisualMediaAdapter;
 constructor(resources:VisualResourcePort,validate?:VisualValidator){this.#visual=new VisualMediaAdapter(resources,validate);}
 supports(kind:MediaKind,goal:MediaGoal):boolean{return kind==='image'&&(goal==='extract'||goal==='original_upgrade');}
 execute(context:MediaExecution){return this.#visual.execute({...context,goal:'original_upgrade'});}
 close(){return this.#visual.close();}
}
