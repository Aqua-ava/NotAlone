import type {DiagnosticEvent} from './unified-contract.mjs';
export const diagnosticDecisionLimit:number,diagnosticDetailLimit:number,diagnosticByteLimit:number,diagnosticTransportLimit:number,diagnosticNoticeLimit:number;
export interface DiagnosticObservation {observedAt:number;observedNs:bigint;contactPrefix?:string;ambiguousPrefix?:boolean}
export class DiagnosticBuffer<T=DiagnosticEvent>{
 push(event:DiagnosticEvent,value?:T,bytes?:number,observation?:DiagnosticObservation):boolean;
 reserve(bytes:number,observation?:DiagnosticObservation,event?:DiagnosticEvent):boolean;
 reject(observation?:DiagnosticObservation,event?:DiagnosticEvent):false;
 take():{items:T[];dropped:number;notices:DiagnosticEvent[];noticeEntries:{event:DiagnosticEvent;observation?:DiagnosticObservation}[];droppedObservation?:DiagnosticObservation};
 reset():void;
}
export function diagnosticOverflow(caller:string,count:number,traceId?:string):DiagnosticEvent;
