import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {Type} from 'typebox';
import * as runtime from '../src/runtime.mjs';
import * as host from '../src/host-api.mjs';
import {startSupervisor} from '../src/supervisor.mjs';
const result = (value: unknown) => ({content:[{type:'text' as const,text:JSON.stringify(value,null,2)}],details:{}});
export default function paseoPlugin(pi: ExtensionAPI) {
 pi.registerCommand('paseo',{
  description:'Paseo 狀態、設定與開啟完整介面',
  handler:async()=>{const s=await host.status();pi.sendMessage({customType:'paseo',content:'Paseo：'+JSON.stringify({phase:s.phase,daemon:s.daemon,chatVerified:s.chatVerified})+'\n\n[開啟 Paseo](https://app.paseo.sh) · [設定與配對](/paseo/setup)',display:true});}
 });
 pi.registerCommand('paseo-open',{description:'開啟完整 Paseo 介面',handler:async()=>{pi.sendMessage({customType:'paseo',content:'[開啟 Paseo](https://app.paseo.sh)\n\n首次使用請在插件設定頁完成官方 relay 配對。',display:true});}});
 pi.registerCommand('paseo-setup',{description:'開啟 Paseo 初始化與受保護配對畫面',handler:async()=>{pi.sendMessage({customType:'paseo',content:'[Paseo 設定與配對](/paseo/setup)\n\n此頁由隨附 Pi Web 整合層提供，密碼與配對連結請只在設定畫面輸入。',display:true});}});
 pi.registerTool({name:'paseo_status',label:'Paseo status',description:'Read managed Paseo installation, providers, daemon and onboarding status without credentials.',parameters:Type.Object({}),execute:async()=>result(await host.status())});
 pi.registerTool({name:'paseo_models',label:'Paseo models',description:'Discover available models, modes and thinking levels for Claude Code, Codex or Pi.',parameters:Type.Object({provider:Type.Union([Type.Literal('claude'),Type.Literal('codex'),Type.Literal('pi')])}),execute:async(_id,p)=>result(await runtime.listModels(p.provider))});
 pi.registerTool({name:'paseo_diagnose',label:'Paseo diagnostic',description:'Diagnose managed provider startup and authentication using redacted output.',parameters:Type.Object({}),execute:async()=>result(await runtime.diagnose())});
 pi.registerTool({name:'paseo_chat',label:'Paseo chat',description:'Start a conversation with an available coding agent through the managed Paseo daemon. Select discovered models/modes and preserve default privileges.',parameters:Type.Object({provider:Type.Union([Type.Literal('claude'),Type.Literal('codex'),Type.Literal('pi')]),message:Type.String(),model:Type.Optional(Type.String()),mode:Type.Optional(Type.String()),thinking:Type.Optional(Type.String()),cwd:Type.Optional(Type.String()),title:Type.Optional(Type.String())}),execute:async(_id,p)=>result(await runtime.createChat(p))});
 pi.registerTool({name:'paseo_continue',label:'Paseo continuation',description:'Continue an existing conversation created through Paseo.',parameters:Type.Object({agentId:Type.String(),message:Type.String()}),execute:async(_id,p)=>result(await runtime.continueChat(p))});
 pi.on('session_start',async(_event,ctx)=>{
  // Registration is cheap; all daemon work is deferred to this lifecycle.
  if(process.env.PI_PASEO_DISCOVERY_ONLY==='1')return;
  const supervisor=await startSupervisor({fallbackOnboarding:true,cwd:ctx.cwd});
  if(!supervisor.running){ctx.ui.setStatus('paseo','Paseo 已停止 · /paseo');return;}
  ctx.ui.setStatus('paseo','Paseo 已啟用 · /paseo');
 });
}
