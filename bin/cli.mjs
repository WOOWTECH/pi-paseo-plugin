#!/usr/bin/env node
import * as runtime from '../src/runtime.mjs';
import * as host from '../src/host-api.mjs';
import { startSupervisor, supervise } from '../src/supervisor.mjs';
const [action='status',...args]=process.argv.slice(2);
try {
 let result;
 if(action==='postinstall') {
  if(process.env.PI_PASEO_SKIP_POSTINSTALL==='1') process.exit(0);
  const {installHost}=await import('./install-host.mjs');
  const installation=await installHost();
  const lifecycle=await host.lifecycle({action:'install',prepareRuntime:true});
  result={...await host.status(),hostInstallation:installation,lifecycle};
 } else if(action==='install'||action==='start'||action==='enable') result=await host.lifecycle({action:'enable'});
 else if(action==='stop'||action==='disable') result=await host.lifecycle({action:'disable'});
 else if(action==='status') result=await host.status();
 else if(action==='diagnose') result=await runtime.diagnose();
 else if(action==='models') result=await runtime.listModels(args[0]);
 else if(action==='pair') {
  if(!args.includes('--reveal'))throw new Error('Use the protected Pi Web setup page, or pair --reveal in a private terminal');
  result=await runtime.pair();
 } else if(action==='acceptance') result=await runtime.acceptance();
 else if(action==='supervise') {await supervise({fallbackOnboarding:args.includes('--fallback-onboarding')});process.exit(0);}
 else if(action==='supervisor') result=await startSupervisor({fallbackOnboarding:true});
 else if(action==='install-host') {const {installHost}=await import('./install-host.mjs');result=await installHost();}
 else throw new Error('Use install, status, diagnose, models PROVIDER, pair --reveal, acceptance, stop, or install-host');
 process.stdout.write(JSON.stringify(result,null,2)+'\n');
} catch(error) {
 // Never forward provider stderr, config bodies, passwords or pairing links.
 process.stderr.write(JSON.stringify({error:error?.name||'Error',message:action==='pair'?'Pairing requires a ready managed daemon and protected setup entry':'Pi Paseo operation failed; see redacted status and diagnostics'})+'\n');
 process.exitCode=1;
}
