import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {Type} from 'typebox';
import * as runtime from '../src/runtime.mjs';
import * as host from '../src/host-api.mjs';
import {startSupervisor} from '../src/supervisor.mjs';
const result = (value: unknown) => ({content:[{type:'text' as const,text:JSON.stringify(value,null,2)}],details:{}});
export default function paseoPlugin(pi: ExtensionAPI) {
 pi.registerTool({name:'paseo_status',label:'Paseo status',description:'Read managed Paseo installation, providers and daemon status without credentials.',parameters:Type.Object({}),execute:async()=>result(await host.status())});
 pi.registerTool({name:'paseo_models',label:'Paseo models',description:'Discover available models, modes and thinking levels for Claude Code, Codex or Pi.',parameters:Type.Object({provider:Type.Union([Type.Literal('claude'),Type.Literal('codex'),Type.Literal('pi')])}),execute:async(_id,p)=>result(await runtime.listModels(p.provider))});
 pi.registerTool({name:'paseo_diagnose',label:'Paseo diagnostic',description:'Diagnose managed provider startup and authentication using redacted output.',parameters:Type.Object({}),execute:async()=>result(await runtime.diagnose())});
 pi.registerTool({name:'paseo_chat',label:'Paseo chat',description:'Start a conversation with an available coding agent through the managed Paseo daemon. Select discovered models/modes and preserve default privileges.',parameters:Type.Object({provider:Type.Union([Type.Literal('claude'),Type.Literal('codex'),Type.Literal('pi')]),message:Type.String(),model:Type.Optional(Type.String()),mode:Type.Optional(Type.String()),thinking:Type.Optional(Type.String()),cwd:Type.Optional(Type.String()),title:Type.Optional(Type.String())}),execute:async(_id,p)=>result(await runtime.createChat(p))});
 pi.registerTool({name:'paseo_continue',label:'Paseo continuation',description:'Continue an existing conversation created through Paseo.',parameters:Type.Object({agentId:Type.String(),message:Type.String()}),execute:async(_id,p)=>result(await runtime.continueChat(p))});
 pi.on('session_start',async(_event,ctx)=>{
  // Registration is cheap; all daemon work is deferred to this lifecycle.
  if(process.env.PI_PASEO_DISCOVERY_ONLY==='1')return;
  await startSupervisor({cwd:ctx.cwd});
 });
}
