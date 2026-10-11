import test from 'node:test';
import assert from 'node:assert/strict';
import {healthReport} from '../src/health.mjs';
const ready=()=>({installed:true,enabled:true,daemon:{owned:true,running:true,reachable:true,relayEnabled:true},providers:['claude','codex','pi'].map(provider=>({provider,status:'ready',enabled:true,chatVerified:true})),state:{providerLaunchers:Object.fromEntries(['claude','codex','pi'].map(p=>[p,{startup:'ready'}])),acceptance:{passed:true,checkedAt:'2026-10-11T16:00:00.000Z'}}});
test('operational health distinguishes current daemon availability from historical chats',()=>{
 const s=ready(),r=healthReport(s);assert.equal(r.ready,true);assert.equal(r.chatAcceptance.historical,true);assert.equal(r.chatAcceptance.checkedAt,s.state.acceptance.checkedAt);
 s.daemon.reachable=false;assert.equal(healthReport(s).ready,false);assert.ok(healthReport(s).codes.includes('DAEMON_UNREACHABLE'));
});
test('a stopped, missing or restart-required service cannot produce a successful health result',()=>{
 for(const change of [{enabled:false},{installed:false},{diagnosticCode:'RESTART_REQUIRED'}]){const s={...ready(),...change};assert.equal(healthReport(s).ready,false);}
});
test('provider executable failure and disabled providers remain visible even after a passing chat',()=>{
 const s=ready();s.state.providerLaunchers.codex.startup='COMMAND_FAILED';s.providers[0].enabled=false;
 const r=healthReport(s);assert.equal(r.ready,false);assert.ok(r.codes.includes('PROVIDER_CODEX_UNAVAILABLE'));assert.ok(r.codes.includes('PROVIDER_CLAUDE_UNAVAILABLE'));
});
test('health outputs omit paths, arbitrary errors and pairing/account secrets',()=>{
 const s=ready();s.secret='sentinel';s.state.pairingUrl='sentinel';s.diagnosticCode='https://sentinel';s.state.acceptance.checkedAt='sentinel';
 const r=healthReport(s);assert.doesNotMatch(JSON.stringify(r),/sentinel/);assert.equal(r.chatAcceptance.checkedAt,null);
});
