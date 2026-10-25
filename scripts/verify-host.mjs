#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {readAdapter,runCommand} from '../bin/install-host.mjs';
import {repairSdkDependency} from '../bin/repair-sdk-dependency.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);let temp,stage='input';
try {
 if(args.length&&!(args.length===2&&args[0]==='--checkout'))throw new Error('Invalid arguments');
 const meta=readAdapter(root);
 const env={...process.env,PI_PASEO_SKIP_POSTINSTALL:'1',PI_PASEO_DISCOVERY_ONLY:'1',PI_PASEO_PLUGIN_ROOT:root,NEXT_TELEMETRY_DISABLED:'1',CIRCLE_NODE_TOTAL:'3',npm_config_production:'false',NPM_CONFIG_PRODUCTION:'false'};
 let host;
 if(args.length) {
  host=fs.realpathSync(path.resolve(args[1]));stage='checkout';
  if(await runCommand('git',['rev-parse','HEAD'],{cwd:host,env})!==meta.baseCommit)throw new Error('Wrong base');
  await runCommand('git',['apply','--reverse','--check',meta.patchFile],{cwd:host,env});
 } else {
  temp=fs.mkdtempSync(path.join(os.tmpdir(),'pi-paseo-host-check-'));host=temp;stage='checkout';
  await runCommand('git',['init','--quiet'],{cwd:host,env});
  await runCommand('git',['fetch','--quiet','--depth=1',meta.repository,meta.baseCommit],{cwd:host,env});
  await runCommand('git',['checkout','--quiet','--detach','FETCH_HEAD'],{cwd:host,env});
  await runCommand('git',['apply','--check',meta.patchFile],{cwd:host,env});
  await runCommand('git',['apply',meta.patchFile],{cwd:host,env});
 }
 if(!fs.existsSync(path.join(host,'node_modules/next/dist/bin/next'))) {
  stage='dependencies';await runCommand('npm',['ci','--include=dev','--no-audit','--no-fund'],{cwd:host,env:{...env,NODE_ENV:'development'}});
 }
 stage='tests';
 repairSdkDependency(host);
 const tests=fs.readdirSync(path.join(host,'lib')).filter(x=>/^paseo.*\.test\.mjs$/.test(x)).map(x=>'lib/'+x);
 for(const file of ['app/api/plugins/route.test.mjs','app/api/plugin-paseo/route.test.mjs','components/PaseoPluginPanel.behavior.test.mjs','lib/json-request.test.mjs','lib/request-security.test.mjs','proxy.test.mjs'])if(fs.existsSync(path.join(host,file)))tests.push(file);
 const output=await runCommand(process.execPath,['--experimental-strip-types','--test',...tests],{cwd:host,env});
 const count=Number(output.match(/^# pass (\d+)$/m)?.[1]);
 if(!count||!/^# fail 0$/m.test(output))throw new Error('Host tests failed');
 stage='build';await runCommand('npm',['run','build'],{cwd:host,env:{...env,NODE_ENV:'production'}});
 if(!fs.readFileSync(path.join(host,'.next/BUILD_ID'),'utf8').trim())throw new Error('Missing build');
 if(process.env.PI_WEB_SCROLL_E2E==='1') {
  stage='browser';
  if(!process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)await runCommand(process.execPath,['node_modules/playwright/cli.js','install','--with-deps','chromium'],{cwd:host,env});
  await runCommand(process.execPath,['e2e/paseo-mobile-scroll-runner.mjs'],{cwd:host,env:{...env,PI_WEB_SCROLL_SURFACE:'setup'}});
 }
 console.log(JSON.stringify({passed:true,tests:count,build:'production',base:meta.baseCommit,patchSha256:meta.patchSha256}));
} catch {
 console.error(JSON.stringify({passed:false,stage,code:'HOST_VERIFICATION_FAILED'}));process.exitCode=1;
} finally {if(temp)fs.rmSync(temp,{recursive:true,force:true});}
