import {readFile, readdir, cp, lstat} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {validateRomanceBundle, romanceBundleRoot} from '../../scripts/validate_romance_reply_skills.mjs';
import {checkNoLinks, readPackage} from '../../backend-ts/src/skills/skill-package.ts';
const userData='/Users/local-user/Library/Application Support/NotAloneDesktop';
const config=JSON.parse(await readFile(join(userData,'sqlite-development.json'),'utf8'));
const root=config.skillPackageRoot;
if(typeof root!=='string'||resolve(root)!==join(userData,'skill-packages'))throw new Error('configured_skill_root_changed');
checkNoLinks(root);if(!(await lstat(root)).isDirectory())throw new Error('skill_root_not_directory');
const {catalog}=await validateRomanceBundle();
const existing=new Set(await readdir(root));let copied=0,unchanged=0;
for(const entry of catalog.entries){
 const source=join(romanceBundleRoot,entry.name),target=join(root,entry.name);
 if(existing.has(entry.name)){if(readPackage(source).package_sha256!==readPackage(target).package_sha256)throw new Error('existing_package_differs:'+entry.name);unchanged++;continue;}
 await cp(source,target,{recursive:true,force:false,errorOnExist:true});copied++;
 if(readPackage(source).package_sha256!==readPackage(target).package_sha256)throw new Error('copied_package_differs:'+entry.name);
}
const raw=await readFile(join(userData,'managed/sqlite-backend.info'),'utf8');
const fields=Object.fromEntries(raw.trim().split('\n').map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
if(!/^127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(fields.address)||!fields.token)throw new Error('invalid_handshake');
const endpoint='http://'+fields.address,headers={authorization:'Bearer '+fields.token,'content-type':'application/json'};
async function list(){const response=await fetch(endpoint+'/api/skills',{headers});if(!response.ok)throw new Error('library_read_failed');return (await response.json()).skills;}
const wanted=new Set(catalog.entries.map(e=>e.name));let verified=0;
for(const item of (await list()).filter(item=>wanted.has(item.directory_name))){
 const response=await fetch(endpoint+'/api/skills/'+item.package_id+'/verify',{method:'POST',headers,body:JSON.stringify({expected_head_revision:item.head_revision,confirmed:true})});
 if(!response.ok){const error=await response.json();throw new Error(item.directory_name+':'+error.error);}
 verified++;
}
const items=(await list()).filter(item=>wanted.has(item.directory_name));
console.log(JSON.stringify({copied,unchanged,discovered:items.length,verified,enabled:items.filter(i=>i.enabled_state==='enabled').length,pendingEnable:items.filter(i=>i.enabled_state==='unknown').length,allVerified:items.every(i=>i.verification_state==='verified')}));

