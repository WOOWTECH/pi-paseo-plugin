// Offline raw-byte verification; it grants no host access or mutation authority.
import crypto from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { validateProductionReport } from './production-scope.mjs';
import { webTurnChecks } from './provider/acceptance-evidence.mjs';
const hash=raw=>crypto.createHash('sha256').update(raw).digest('hex');
const check=(ok,why)=>{if(!ok)throw Error('Functional capture: '+why);};
const baseNames=['acceptance-manifest.json','provider-acceptance.json','web-jobs.json','web-checkpoint.private.json','web-verification.json'];
export function validateFunctionalCapture(context,host,phase){
 const reader=context.reader,prefix=`hosts/${host.label}/functional/${phase}/`,base=`hosts/${host.label}/evidence/${phase}/`;
 const index=reader.read(prefix+'functional-capture.json').value,bind=index.binding;
 check(index.schema==='agent-connect-functional-capture/v1','schema');validateProductionReport(bind,context,{allowSessions:true});
 for(const[k,v]of Object.entries({release:host.release,phase,runtimeIdentity:host.runtimeIdentity,dataIdentity:host.dataIdentity,serverId:host.serverId}))check(bind[k]===v,'host/phase identity');
 const values={},records={},refs={};
 for(const[name,ref]of Object.entries(index.files)){
  check(baseNames.includes(name)||/^[a-zA-Z0-9_-]+-timeline\.json$/.test(name),'unexpected file');
  check(ref.path==='raw-files/'+name+'.capture.json','raw path');
  const file=reader.read({path:prefix+ref.path,sha256:ref.sha256});check(equal(file.value.binding,bind),'file binding');
  const record=file.value.source,raw=Buffer.from(record.base64,'base64');check(hash(raw)===record.sha256,'raw checksum');
  values[name]=JSON.parse(raw);records[name]={raw,sha256:record.sha256};refs[name]=file.proof;
 }
 for(const name of baseNames)check(values[name],'missing '+name);
 const m=values['acceptance-manifest.json'],r=values['provider-acceptance.json'],w=values['web-verification.json'],cp=values['web-checkpoint.private.json'];
 for(const value of [m,r,w,cp,values['web-jobs.json']])for(const[k,v]of Object.entries({runId:bind.runId,hostLabel:host.label,runtimeIdentity:host.runtimeIdentity}))check(value[k]===v,'original identity');
 for(const value of [r,w,cp,values['web-jobs.json']])check(value.phase===phase,'original phase');
 check(m.scope==='production-canary'&&m.workspaceRoot==='/data/pi-agent/home/work/canary-'+bind.runId,'workspace');
 check(cp.jobsSha256===records['web-jobs.json'].sha256,'job checksum');
 const names=new Set(baseNames),remote=m.workspaceRoot+'/'+phase+'/';
 function walk(value){if(Array.isArray(value))return value.forEach(walk);if(!value||typeof value!=='object')return;
  for(const[k,v]of Object.entries(value))if(['evidenceFile','receiverEvidenceFile','priorProviderEvidenceFile'].includes(k)){
   check(typeof v==='string'&&v.startsWith(remote)&&/^[a-zA-Z0-9_-]+-timeline\.json$/.test(v.slice(remote.length)),'remote timeline path');names.add(v.slice(remote.length));
  }else walk(v);
 }
 walk(r);walk(w);check(equal([...names].sort(),Object.keys(values).sort()),'timeline inventory');
 for(const name of names)if(name.endsWith('-timeline.json')){
  check(Array.isArray(values[name]),'timeline array');check(reader.read(base+name,{json:false}).raw.equals(records[name].raw),'timeline bytes changed');
 }
 const derived=reader.read(base+'web-verification.json').value;
 check(equal(derived,{...w,...bind,rawSourceSha256:records['web-verification.json'].sha256,rawCapture:refs['web-verification.json']}),'web report relabelled');
 for(const name of ['provider-acceptance.json','web-checkpoint.private.json']){
  const actual=reader.read(base+name).value;validateProductionReport(actual,context,{allowSessions:true});
  check(actual.sourceManifestSha256===bind.sourceManifestSha256&&actual.rawSourceSha256===records[name].sha256,'completion capture differs');
  const original=reader.read(actual.rawCapture).value;check(equal(original.binding,bind)&&original.source.sha256===records[name].sha256&&Buffer.from(original.source.base64,'base64').equals(records[name].raw),'completion original differs');
  check(equal(actual,{...values[name],...bind,...(name==='provider-acceptance.json'?{creationResolutions:actual.creationResolutions}:{}),rawSourceSha256:records[name].sha256,rawCapture:actual.rawCapture}),'derived provider changed');
 }
 check(w.providers?.length===3&&new Set(w.providers.map(p=>p.provider)).size===3,'provider inventory');
 for(const row of w.providers){
  const job=cp.jobs.find(j=>j.provider===row.provider);check(job&&row.agentId===job.agentId&&row.targetModel===job.targetModel,'job/model binding');
  const written=m.writes?.find(x=>x.key===job.writeKey&&x.agentId===job.agentId&&x.provider===job.provider&&x.phase===phase&&x.source==='public-web');
  // Reuse the exact observer's resource checks. Persisted metadata is the
  // original verified manifest write, not a newly invented current observation.
  const stored=written?{key:written.key,content:written.marker,revision:written.revision}:null;
  const checks=webTurnChecks(null,job,values[path.basename(row.evidenceFile)],stored);
  for(const key of ['freshMemoryRead','freshSkillRead','freshSharedMemorySkillRead','freshGlobalMcpCall','freshMemoryWriteRead','freshMemoryWrite','persistedMemoryWrite','answered'])
   if(row.checks?.[key]===true)check(checks[key]===true,'claimed tool evidence missing: '+key);
 }
 return {index:reader.read(prefix+'functional-capture.json').proof,files:Object.values(refs)};
}
