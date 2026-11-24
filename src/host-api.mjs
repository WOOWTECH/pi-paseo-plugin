import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as runtime from './runtime.mjs';
import { readRecord, writeRecord, withLock } from './onboarding.mjs';
import { startSupervisor, stopSupervisor, packageEnabled } from './supervisor.mjs';
import { serveWebClient, webClientStatus } from './web-client.mjs';
import { CONNECTION_TARGETS, connectionPreferences, connectionTarget } from './connection-targets.mjs';

const enabledBinding = p => p.disabled !== true && p.status !== 'disabled' && p.status !== 'missing';
export async function status() {
  const result=await runtime.status();
  // The switch shows what agents get: the daemon config (a Paseo client can change it too),
  // reported by the runtime status; a runtime without it leaves the saved preference.
  const preferences = connectionPreferences(runtime.locations());
  const settings = { ...preferences, agentCollaboration: typeof result.agentCollaboration === 'boolean' ? result.agentCollaboration : preferences.agentCollaboration === true };
  const activeTarget = result.daemon?.running ? result.state?.activeTarget || 'paseo' : null;
  const configurationPending = result.state?.configurationPending === true || (activeTarget !== null && activeTarget !== settings.target);
  return {...result,
    openUrl:connectionTarget(settings.target).openUrl,webClient:webClientStatus(runtime.locations()),setupUrl:'/paseo/setup',settings,
    selectedTarget:settings.target,activeTarget,configurationPending,
    connectionTargets:CONNECTION_TARGETS.map(({id,label,appUrl})=>({id,label,appUrl}))};
}
export function web(request) { return serveWebClient(request, runtime.locations()); }
export async function lifecycle(input={}) {
  const loc=runtime.locations();
  return withLock(path.join(loc.stateDir,'host-lifecycle.lock'),async()=>{
    const file=path.join(loc.stateDir,'host-registration.json'),previous=readRecord(file);
    const explicitStop=['disable','stop','remove'].includes(input.action);
    const explicitEnable=['enable','activate'].includes(input.action);
    const active=!explicitStop&&(explicitEnable||previous.enabled!==false)&&
      (Array.isArray(input.packages)?input.packages.some(enabledBinding):input.action==='restore'?packageEnabled(loc):true);
    writeRecord(file,{enabled:active,packageRoot:path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),cwd:input.cwd||previous.cwd||loc.home,registeredAt:new Date().toISOString()});
    if (!active) {
      // A supervisor may still be finishing activate(). Deactivate only after it exits.
      await stopSupervisor();
      await runtime.deactivate();
      return {phase:'disabled'};
    }
    // npm may run before Pi writes the binding; the persisted pause still wins.
    if(input.prepareRuntime===true)await runtime.activate();
    const supervisor=await startSupervisor();
    if(!supervisor.running)return {phase:'disabled'};
    return {phase:'starting',scheduled:true};
  },{timeoutMs:input.prepareRuntime===true?360000:15000});
}
export async function restore() { return lifecycle({action:'restore'}); }
export async function listModels(provider) { return runtime.listModels(provider); }
export async function diagnostics() { return runtime.diagnose(); }
export async function pair() {
  const result=await runtime.pair();
  return {url:result.url,target:result.target, ...(result.expiresAt?{expiresAt:result.expiresAt}:{})};
}
export async function saveConfig(input) {
  return runtime.saveConnectionSettings(input);
}
