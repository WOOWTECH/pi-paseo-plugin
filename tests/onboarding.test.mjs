import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ensureOnboarding,onboardingStatus,withLock} from '../src/onboarding.mjs';
test('concurrent activation creates one durable onboarding conversation',async()=>{
 const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'paseo-onboarding-'));
 const loc={stateDir};let calls=0;
 const create=async()=>{calls++;await new Promise(r=>setTimeout(r,50));return 'session-one';};
 try {
  const [a,b]=await Promise.all([ensureOnboarding(create,loc),ensureOnboarding(create,loc)]);
  assert.equal(calls,1);assert.equal(a.sessionId,b.sessionId);
  assert.equal((await ensureOnboarding(create,loc)).sessionId,'session-one');assert.equal(calls,1);
  assert.equal(fs.statSync(path.join(stateDir,'onboarding.json')).mode&0o777,0o600);
 } finally {fs.rmSync(stateDir,{recursive:true,force:true});}
});
test('an unknown creation result prevents blind duplicate conversations',async()=>{
 const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'paseo-onboarding-'));const loc={stateDir};let calls=0;
 try {
  await assert.rejects(ensureOnboarding(async()=>{calls++;throw new Error('connection lost');},loc));
  await assert.rejects(ensureOnboarding(async()=>{calls++;return 'duplicate';},loc),/reconciliation/);
  assert.equal(calls,1);assert.equal(onboardingStatus(loc).creation,'pending');
 } finally {fs.rmSync(stateDir,{recursive:true,force:true});}
});
test('failed operation releases its file lock for a later retry',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'paseo-lock-'));const lock=path.join(dir,'op.lock');
 try {await assert.rejects(withLock(lock,()=>{throw new Error('failed');}));assert.equal(await withLock(lock,()=>42),42);}
 finally {fs.rmSync(dir,{recursive:true,force:true});}
});
