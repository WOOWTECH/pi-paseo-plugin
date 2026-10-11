import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { locations } from './runtime.mjs';

export function readRecord(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw new Error('Invalid plugin state file'); }
}
export function writeRecord(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(record, null, 2) + '\n', {mode:0o600});
  fs.renameSync(temp, file);
}
export async function withLock(file, fn, { timeoutMs = 15000 } = {}) {
  fs.mkdirSync(path.dirname(file), {recursive:true, mode:0o700});
  const until = Date.now() + timeoutMs;
  while (true) {
    try { fs.mkdirSync(file, {mode:0o700}); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const owner = readRecord(path.join(file, 'owner.json'));
      let live = false;
      try { if (owner.pid) { process.kill(owner.pid,0); live=true; } } catch (error) { live = error.code === 'EPERM'; }
      const age = Date.now()-fs.statSync(file).mtimeMs;
      if (!live && age > 30000) { fs.rmSync(file,{recursive:true,force:true}); continue; }
      if (Date.now()>until) throw new Error('Plugin operation is already running');
      await new Promise(r=>setTimeout(r,100));
    }
  }
  writeRecord(path.join(file,'owner.json'), {pid:process.pid});
  try { return await fn(); } finally { fs.rmSync(file,{recursive:true,force:true}); }
}
export function onboardingStatus(loc = locations()) {
  return readRecord(path.join(loc.stateDir,'onboarding.json'));
}
export const onboardingPrompt = '這是使用者已授權的 Paseo 連線初始化對話。插件會在目前容器安裝並管理 Paseo，沿用 Claude Code、Codex、Pi 現有登入。' +
 '請用繁體中文呼叫 paseo_status，說明安裝、模型與登入狀態；引導使用者由插件設定頁完成官方 relay 配對。' +
 '官方 relay 通常不需要 Paseo 帳號密碼。密碼、API Key、配對連結只輸入受保護的設定畫面，不能貼到聊天或工具。' +
 '未完成設定時續用本對話，不建立重複對話，不自行更改權限、重裝全域工具、重啟 Pi Web 或操作其他服務。';
export async function ensureOnboarding(create, loc = locations()) {
  return withLock(path.join(loc.stateDir,'onboarding.lock'), async()=>{
    const file=path.join(loc.stateDir,'onboarding.json');
    let record=readRecord(file);
    if (record.sessionId) return record;
    if (record.creation === 'pending') throw new Error('Onboarding creation needs reconciliation; automatic duplicate creation is stopped');
    record={...record,creation:'pending',requestedAt:new Date().toISOString()};
    writeRecord(file,record);
    try {
      const created=await create(onboardingPrompt);
      const sessionId=typeof created==='string'?created:created?.sessionId;
      if (!sessionId) throw new Error('Host did not return an onboarding session id');
      record={...record,sessionId,creation:'created',completed:false};
      writeRecord(file,record);
      return record;
    } catch (e) {
      writeRecord(file,{...record,error:'Host could not confirm onboarding creation'});
      throw e;
    }
  });
}
export async function localWebApi(route, body, {method='POST', cookie, port=process.env.PI_WEB_PORT||process.env.PORT||'30141'}={}) {
  if (!/^\d{1,5}$/.test(String(port))||Number(port)<1||Number(port)>65535) throw new Error('Invalid Pi Web port');
  const response=await fetch('http://127.0.0.1:'+port+route,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
  if (!response.ok) throw new Error('Pi Web request rejected (HTTP '+response.status+')');
  return response;
}
export async function createViaLocalWeb(prompt, loc=locations()) {
  let cookie;
  if (process.env.PI_WEB_PASSWORD) {
    const login=await localWebApi('/api/web-auth',{password:process.env.PI_WEB_PASSWORD});
    cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  }
  const response=await localWebApi('/api/agent/new',{cwd:loc.home,type:'ensure_session'},{cookie});
  const created=await response.json();
  if (!created.sessionId) throw new Error('Pi Web returned no session');
  await localWebApi('/api/agent/'+created.sessionId,{type:'set_session_name',name:'Paseo 連線初始化'},{cookie});
  await localWebApi('/api/agent/'+created.sessionId,{type:'prompt',message:prompt},{cookie});
  return created.sessionId;
}
