#!/usr/bin/env node
import fs from 'node:fs';
import { runCommand } from '../bin/install-host.mjs';

// Bootstrap commands share the host installer's timeout, output limit,
// interruption handling, and process-group cleanup. Never forward failures'
// child output: credential helpers and npm hooks can print private material.
const args = process.argv.slice(2);
const stdin = args[0] === '--stdin';
if (stdin) args.shift();
const command = args.shift();
const timeoutMs = Number(process.env.PI_PASEO_BOOTSTRAP_TIMEOUT_MS ?? 900000);
const killGraceMs = Number(process.env.PI_PASEO_COMMAND_KILL_GRACE_MS ?? 1000);
try {
  if (!command || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647 ||
      !Number.isSafeInteger(killGraceMs) || killGraceMs < 0 || killGraceMs > 60000) throw { code: 'INVALID_ARGUMENTS' };
  const output = await runCommand(command, args, {
    env: process.env, timeoutMs, killGraceMs, input: stdin ? fs.readFileSync(0) : undefined,
  });
  if (output) process.stdout.write(output + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ error: 'BootstrapCommandError', code: error.code || 'COMMAND_FAILED' }) + '\n');
  process.exitCode = error.code === 'COMMAND_INTERRUPTED' ? 130 : 1;
}
