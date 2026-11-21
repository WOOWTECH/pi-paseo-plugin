import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const craftRelease = Object.freeze({
  version: '0.6.1',
  sourceCommit: 'e64d7cb73d7f39323b7040a984e0f9b3f7981146',
  url: 'https://github.com/storytold/craft-anything/releases/download/v0.6.1/craft-anything-0.6.1-linux-x86_64.tar.gz',
  archiveSha256: '83ec0730c9117f399122b315c63ed4c3a8d31ac55bddd74cb8b33cd2f76ef704',
  cliSha256: '48272fc45ba816c773eaf3d4bf82105d3157c3a61f53be640d949d95ddccf99b',
});

// These replacements are explicit and intentionally leave version/feature differences visible.
export const brandNormalization = [
  ['https://smart.woowtech.io', 'https://agent-connect.example'],
  ['https://smart.apporo.ai', 'https://agent-connect.example'],
  ['https://app.paseo.sh', 'https://agent-connect.example'],
  ['woowtech smart', 'Agent Connect'],
  ['Apporo smart', 'Agent Connect'],
  ['Paseo', 'Agent Connect'],
].map(([match, replacement], i) => ({ rule_id: `brand-${i}`, match, replacement }));

export function assertWalkthrough(evidence, expectedStepIds) {
  const result = evidence?.result;
  if (evidence?.operation !== 'web_walkthrough_record' || !result) throw new Error('Missing Craft walkthrough evidence');
  if (result.aborted != null) throw new Error('Craft walkthrough aborted');
  if (evidence.coverage?.status !== 'complete') throw new Error('Craft evidence incomplete or truncated');
  if (result.action_count !== expectedStepIds.length || result.steps?.length !== expectedStepIds.length) throw new Error('Incomplete walkthrough');
  for (const [i, step] of result.steps.entries()) {
    if (step.step_id !== expectedStepIds[i] || step.status !== 'ok') throw new Error(`Walkthrough step failed or missing: ${expectedStepIds[i]}`);
  }
  // A successful click does not prove the resulting UI state. Callers must also assert it.
  return { evidenceId: evidence.id, steps: result.steps.length };
}

export class Craft {
  constructor({ cli, project, outputDir }) {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(cli)).digest('hex');
    if (hash !== craftRelease.cliSha256) throw new Error('Craft CLI does not match pinned release');
    this.cli = path.resolve(cli);
    this.project = path.resolve(project);
    this.outputDir = path.resolve(outputDir);
    fs.mkdirSync(this.outputDir, { recursive: true, mode: 0o700 });
  }

  async call(tool, params, name, timeoutMs = 120000) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Invalid evidence filename');
    return new Promise((resolve, reject) => {
      const child = spawn(this.cli, ['--project', this.project, '--deep', '--allow-run', tool, '--json', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
      const stdout = [], stderr = [];
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.stdout.on('data', b => stdout.push(b));
      child.stderr.on('data', b => stderr.push(b));
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('close', code => {
        clearTimeout(timer);
        const raw = Buffer.concat(stdout);
        fs.writeFileSync(path.join(this.outputDir, `${name}.json`), raw, { mode: 0o600 });
        // Never include captured page/request content in exceptions or CI logs.
        if (code !== 0) return reject(new Error(`Craft ${tool} failed (${code}); inspect private ${name}.json`));
        try { resolve(JSON.parse(raw)); } catch { reject(new Error(`Invalid Craft JSON in ${name}.json`)); }
      });
      child.stdin.on('error', reject);
      child.stdin.end(JSON.stringify(params));
    });
  }

  async record({ page, cdpEndpoint, actions, name, secrets = [] }) {
    const session = await page.context().newCDPSession(page);
    let target;
    try { target = (await session.send('Target.getTargetInfo')).targetInfo.targetId; }
    finally { await session.detach(); }
    const params = {
      cdp_endpoint: cdpEndpoint, target_id: target,
      timeout_secs: 60, action_timeout_ms: 20000,
      capture_network: true,
      keep_bodies: { request_body: false, response_body: false, header_values: false },
      environment: { width: 1440, height: 1000, locale: 'en-US', timezone: 'UTC', color_scheme: 'light', reduced_motion: true, bypass_service_workers: true },
      actions,
      capture: { at_end: ['dom', 'accessibility', 'history', 'storage_keys'], events: ['console', 'page_errors', 'websockets'] },
      hidden_values: secrets,
    };
    const check = await this.call('web-walkthrough-check', { script: params }, `${name}-schema`);
    if (check.result?.valid !== true) throw new Error(`Invalid Craft script: ${name}`);
    const evidence = await this.call('web-walkthrough-record', params, name);
    assertWalkthrough(evidence, actions.map(a => a.step_id));
    return evidence;
  }

  async compare(before, after, name) {
    if (![before, after].every(value => typeof value?.id === 'string' && /^ev_[a-f0-9]{64}$/.test(value.id)))
      throw new Error('Craft comparison requires retained evidence descriptors with exact IDs');
    // Use retained IDs: parsing/re-serializing browser floating point timestamps in JS can
    // change a content-addressed evidence hash. Keep the original Craft store alongside JSON.
    const evidence = await this.call('web-snapshots-compare', {
      before: { kind: 'saved', evidence_id: before.id },
      after: { kind: 'saved', evidence_id: after.id },
      normalization: brandNormalization,
    }, name);
    if (evidence.result?.comparable !== true) throw new Error(`Non-comparable Craft runs: ${name}`);
    return evidence;
  }
}
