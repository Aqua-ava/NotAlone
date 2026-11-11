import type {DiagnosticEvent} from './unified-contract.mjs';
export const diagnosticDecisionLimit:number,diagnosticDetailLimit:number,diagnosticByteLimit:number,diagnosticTransportLimit:number;
export class DiagnosticBuffer<T=DiagnosticEvent>{
 push(event:DiagnosticEvent,value?:T,bytes?:number):boolean;
 take():{items:T[];dropped:number;notices:DiagnosticEvent[]};
 reset():void;
}
export function diagnosticOverflow(caller:string,count:number,traceId?:string):DiagnosticEvent;
