import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as runtime from './runtime.mjs';
import { readRecord, writeRecord, withLock } from './onboarding.mjs';
import { startSupervisor, stopSupervisor, packageEnabled } from './supervisor.mjs';
import { CONNECTION_TARGETS, connectionPreferences, connectionTarget } from './connection-targets.mjs';

const enabledBinding = p => p.disabled !== true && p.status !== 'disabled' && p.status !== 'missing';
// #29: Agent Connect 0.1.4-0.1.23 (the Paseo 0.11.2 runtime) kept a user's off only in state.json; their
// host-registration.json still says enabled. True only while the state still comes from that era: the first
// activate() of a newer release records its own installedVersion. supervisor.mjs keeps the same rule; both stay
// free of new imports because hosts load these modules with fixed dependency lists. Unreadable state: no off.
function legacyStateOff(loc) {
  try { const state = readRecord(path.join(loc.stateDir, 'state.json')); return state.desiredEnabled === false && state.installedVersion === '0.11.2'; }
  catch { return false; }
}
export async function status() {
  const result=await runtime.status();
  // The switch shows what agents get: the daemon config (a Paseo client can change it too),
  // reported by the runtime status; a runtime without it leaves the saved preference.
  const preferences = connectionPreferences(runtime.locations());
  const settings = { ...preferences, agentCollaboration: typeof result.agentCollaboration === 'boolean' ? result.agentCollaboration : preferences.agentCollaboration === true };
  const activeTarget = result.daemon?.running ? result.state?.activeTarget || 'paseo' : null;
  const configurationPending = result.state?.configurationPending === true || (activeTarget !== null && activeTarget !== settings.target);
  return {...result,
    openUrl:connectionTarget(settings.target).openUrl,setupUrl:'/paseo/setup',settings,
    selectedTarget:settings.target,activeTarget,configurationPending,
    connectionTargets:CONNECTION_TARGETS.map(({id,label,appUrl})=>({id,label,appUrl}))};
}
export async function lifecycle(input={}) {
  const loc=runtime.locations();
  return withLock(path.join(loc.stateDir,'host-lifecycle.lock'),async()=>{
    const file=path.join(loc.stateDir,'host-registration.json'),previous=readRecord(file);
    const explicitStop=['disable','stop','remove'].includes(input.action);
    const explicitEnable=['enable','activate'].includes(input.action);
    // #29: an off from the 0.11.2 era lives in state.json only. Carry it into the registration instead of switching
    // on a Paseo the owner never enabled; an explicit enable still turns it on. Either way the registration records
    // that the old state has been dealt with, so the supervisor stops reading it.
    const legacy=!explicitStop&&previous.legacyOffResolved!==true&&previous.enabled!==false&&legacyStateOff(loc);
    const legacyOff=legacy&&!explicitEnable;
    const active=!explicitStop&&!legacyOff&&(explicitEnable||previous.enabled!==false)&&
      (Array.isArray(input.packages)?input.packages.some(enabledBinding):input.action==='restore'?packageEnabled(loc):true);
    writeRecord(file,{enabled:active,packageRoot:path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),cwd:input.cwd||previous.cwd||loc.home,registeredAt:new Date().toISOString(),...(legacy||previous.legacyOffResolved===true?{legacyOffResolved:true}:{})});
    if (!active) {
      // A supervisor may still be finishing activate(). Deactivate only after it exits.
      const supervisor=await stopSupervisor();
      // A supervisor that ends for a disable stops the daemon itself. If that failed and the daemon is still there, a
      // second attempt here would wait out the same budget again and fail the same way: report what failed. If the daemon
      // is gone (the failure came after it stopped, such as a closing record that could not be written), there is nothing
      // to wait for: deactivate() finds no daemon and finishes the disable at once.
      if(supervisor?.failed&&await runtime.daemonRunning())throw Object.assign(new Error('Stopping Agent Connect failed'),{code:supervisor.failed.code});
      const stopped=await runtime.deactivate();
      // The stop completed; a terminal cleanup it could not confirm is reported next to it, not instead of it.
      const warnings=(Array.isArray(stopped?.warnings)?stopped.warnings:[]).map(row=>row?.code).filter(code=>typeof code==='string');
      return {phase:'disabled',...(warnings.length?{warnings}:{})};
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
