import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {withLock} from '../src/onboarding.mjs';

test('failed operation releases its file lock for a later retry',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'paseo-lock-'));const lock=path.join(dir,'op.lock');
 try {await assert.rejects(withLock(lock,()=>{throw new Error('failed');}));assert.equal(await withLock(lock,()=>42),42);}
 finally {fs.rmSync(dir,{recursive:true,force:true});}
});
