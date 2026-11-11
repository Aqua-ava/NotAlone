import {withDiagnosticLock} from '../../src/diagnostics/maintenance.mjs';
import {join} from 'node:path';
if(process.argv[3]==='append'){
 const {UnifiedDiagnosticLog}=await import('../../src/diagnostics/unified-log.mjs');
 const log=new UnifiedDiagnosticLog(process.argv[2],{proc:'backend'});await log.flush();
 process.on('message',async()=>{
  for(let n=0;n<100;n++){for(const contactPrefix of ['11111111','22222222'])log.diagnose({event:'scope.revision_changed',caller:'select_contact',reasonCode:'contact_selected',contactPrefix});await log.flush();}
  await log.close();process.send('done',()=>process.disconnect());
 });process.send('ready');
}else{
 process.on('message',()=>{});
 await withDiagnosticLock(process.argv[2],async()=>join(process.argv[2],'logs'),async()=>{process.send('locked');await new Promise(()=>{});});
}
