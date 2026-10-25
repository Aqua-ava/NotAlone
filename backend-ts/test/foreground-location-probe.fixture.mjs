import readline from 'node:readline';
const mode=process.argv[2];
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
if(mode==='ready-delay') await new Promise(resolve=>setTimeout(resolve,500));
if(mode==='warm-delay') await new Promise(resolve=>setTimeout(resolve,80));
emit({version:1,event:'ready'});
let ordinal=0;
for await(const line of readline.createInterface({input:process.stdin})) {
 const request=JSON.parse(line);ordinal++;
 if(mode==='hang'){await new Promise(resolve=>setTimeout(resolve,500));}
 if(mode==='permission'){emit({version:1,request_id:request.request_id,result:{ok:false,error:'screen_capture_permission_missing'}});continue;}
 if(mode==='old-id'){request.request_id='00000000-0000-4000-8000-000000000000';}
 if(mode==='float-version'){process.stdout.write('{"version":1.0,"request_id":"'+request.request_id+'","result":{}}\n');continue;}
 if(mode==='duplicate'){process.stdout.write('{"version":1,"version":1,"request_id":"'+request.request_id+'","result":{}}\n');continue;}
 if(mode==='oversized'){process.stdout.write('x'.repeat(65537));continue;}
 if(mode==='multi'){process.stdout.write('{}\n{}\n');continue;}
 if(mode==='utf8'){process.stdout.write(Buffer.from([255,10]));continue;}
 if(mode==='stderr'){process.stderr.write('x'.repeat(200000));}
 if(mode==='bad-header'){emit({version:1,request_id:request.request_id,result:{ok:true,wechat_in_front:true,capture_version:'automatic-header-v4',captured_at:'2026-02-30T00:00:00Z',display_name:'不回显秘密',selected_row_name:'不应读取列表',quality:{layout_verified:true,display_name_confidence:1,name_complete:true}}});continue;}

 const result={ok:true,wechat_in_front:true,capture_version:'automatic-header-v4',captured_at:new Date().toISOString(),display_name:`合成${process.pid}-${ordinal}`,quality:{layout_verified:true,display_name_confidence:0.98,name_complete:true}};
 if(mode==='environment')result.display_name=process.env.NOTALONE_PROBE_TEST_SECRET??'环境已隔离';
 if(mode==='invalid-date')result.captured_at='2026-02-30T00:00:00Z';
 if(mode==='bool-confidence')result.quality.display_name_confidence=true;
 if(mode==='extra-quality')result.quality.body='不得输出正文';
 if(mode==='low-confidence')result.quality.display_name_confidence=0.4;
 if(mode==='legacy'){result.capture_version='automatic-window-v2';result.selected_row_name=result.display_name;result.quality.selected_row_name_confidence=0.95;delete result.quality.name_complete;}
 if(mode==='fallback')result.text_fallback={version:'isolated-color-tail-v1',text:'合成',confidence:0.95,text_complete:true,mask_verified:true};
 if(mode==='bad-fallback')result.text_fallback={version:'isolated-color-tail-v1',text:'合成...',confidence:0.95,text_complete:true,mask_verified:true};
 if(mode==='unknown-error'){emit({version:1,request_id:request.request_id,result:{ok:false,error:'private_secret'}});continue;}
 emit({version:1,request_id:request.request_id,result});
 if(mode==='idle-exit')process.exit(0);
 if(mode==='idle-extra')setTimeout(()=>process.stdout.write('{}\n'),5);
}
