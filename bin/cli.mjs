#!/usr/bin/env node
import * as runtime from '../src/runtime.mjs';
import * as host from '../src/host-api.mjs';
import { startSupervisor, supervise } from '../src/supervisor.mjs';
import {healthReport} from '../src/health.mjs';
import {repairSdkDependency} from './repair-sdk-dependency.mjs';
const [action='status',...args]=process.argv.slice(2);
try {
 let result;
 if(action==='postinstall') {
  repairSdkDependency();
  if(process.env.PI_PASEO_SKIP_POSTINSTALL==='1') process.exit(0);
  const {installHost}=await import('./install-host.mjs');
  const installation=await installHost();
  const lifecycle=await host.lifecycle({action:'install',prepareRuntime:true});
  result={...await host.status(),hostInstallation:installation,lifecycle};
 } else if(action==='install'||action==='start'||action==='enable') result=await host.lifecycle({action:'enable'});
 else if(action==='stop'||action==='disable') result=await host.lifecycle({action:'disable'});
 else if(action==='status') result=await host.status();
 else if(action==='health') {result=healthReport(await runtime.status());if(!result.ready)process.exitCode=1;}
 else if(action==='diagnose') result=await runtime.diagnose();
 else if(action==='models') result=await runtime.listModels(args[0]);
 else if(action==='pair') {
  if(!args.includes('--reveal'))throw new Error('Use the protected Pi Web setup page, or pair --reveal in a private terminal');
  result=await runtime.pair();
 } else if(action==='acceptance') {result=await runtime.acceptance();if(result?.passed!==true)process.exitCode=1;}
 else if(action==='supervise') {await supervise({fallbackOnboarding:args.includes('--fallback-onboarding')});process.exit(0);}
 else if(action==='supervisor') result=await startSupervisor({fallbackOnboarding:true});
 else if(action==='install-host') {const {installHost}=await import('./install-host.mjs');result=await installHost();}
 else throw new Error('Use install, status, health, diagnose, models PROVIDER, pair --reveal, acceptance, stop, or install-host');
 process.stdout.write(JSON.stringify(result,null,2)+'\n');
} catch(error) {
 // Never forward provider stderr, config bodies, passwords or pairing links.
 const codes=new Set(['INSTALL_DISK_FULL','INSTALL_PERMISSION_DENIED','INSTALL_MEMORY_EXHAUSTED','COMMAND_FAILED','COMMAND_UNAVAILABLE','COMMAND_TIMEOUT','COMMAND_INTERRUPTED','COMMAND_OUTPUT_LIMIT','HOST_INSTALL_BUSY','COMBINED_ADAPTER_MISMATCH','EXISTING_UI_OVERLAY_MISMATCH','PREBUILT_SOURCE_MISMATCH','DAEMON_UNREACHABLE','PROVIDER_AUTH_REQUIRED','PROVIDER_TIMEOUT','RESTART_REQUIRED']);
 const stages=new Set(['source','patch','dependencies','audit','build','prebuilt','promote']);
 const code=codes.has(error?.code)?error.code:'OPERATION_FAILED';
 const hints={INSTALL_DISK_FULL:'Not enough disk space. Free build caches or expand storage, then retry installation.',INSTALL_PERMISSION_DENIED:'The installation directory is not writable.',INSTALL_MEMORY_EXHAUSTED:'The build exhausted memory. Increase available memory or use a verified prebuilt UI.'};
 process.stderr.write(JSON.stringify({error:['HostInstallError','UiInstallError','RuntimeError'].includes(error?.name)?error.name:'Error',code,...(stages.has(error?.stage)?{stage:error.stage}:{}),message:hints[code]||(action==='pair'?'Pairing requires a ready managed daemon and protected setup entry':'Pi Paseo operation failed; see redacted status and diagnostics')})+'\n');
 process.exitCode=1;
}
