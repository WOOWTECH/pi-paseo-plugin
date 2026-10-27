import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as runtime from './runtime.mjs';
import { readRecord, writeRecord, withLock } from './onboarding.mjs';
import { startSupervisor, stopSupervisor, packageEnabled } from './supervisor.mjs';
import { serveWebClient, webClientStatus, WEB_BASE_PATH } from './web-client.mjs';

const enabledBinding = p => p.disabled !== true && p.status !== 'disabled' && p.status !== 'missing';
export async function status() {
  const result=await runtime.status();
  return {...result,
    openUrl:WEB_BASE_PATH,webClient:webClientStatus(runtime.locations()),setupUrl:'/paseo/setup',settings:readRecord(path.join(runtime.locations().stateDir,'preferences.json'))};
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
  return {url:result.url, ...(result.expiresAt?{expiresAt:result.expiresAt}:{})};
}
export async function saveConfig(input) {
  if (!input||typeof input!=='object'||Array.isArray(input)) throw new Error('Invalid settings');
  if (Object.keys(input).some(k=>!['name'].includes(k))) throw new Error('Unsupported setting');
  if (input.name!==undefined&&typeof input.name!=='string') throw new Error('Invalid name');
  const name=(input.name||'').trim();
  if (name.length>100||/[\x00-\x1f\x7f]/.test(name)) throw new Error('Invalid name');
  writeRecord(path.join(runtime.locations().stateDir,'preferences.json'),{name:name||'Pi Agent',connection:'relay'});
  // This is a plugin display label. Paseo 0.11.2 has no daemon.name field
  // or rename RPC; its Web app stores renamed host labels on the client.
  // Saving a label must not depend on provider/daemon activation.
  return {saved:true};
}
