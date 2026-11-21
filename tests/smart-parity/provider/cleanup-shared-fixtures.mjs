import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [manifestPath, mode] = process.argv.slice(2);
if (mode !== '--execute') throw new Error('Cleanup requires explicit manifest path and --execute');
const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const { locations, readJSON, saveJSON, digest } = await import(pathToFileURL(path.join(m.root, 'src/common.mjs')));
const { memoryRead, memoryDelete } = await import(pathToFileURL(path.join(m.root, 'src/memory.mjs')));
const { synchronize } = await import(pathToFileURL(path.join(m.root, 'src/sync.mjs')));
const loc = locations();
if (!/^[a-zA-Z0-9_-]{1,45}$/.test(m.runId || '') || m.skillName !== 'acceptance-' + m.runId.toLowerCase() || m.workspaceRoot !== path.join(loc.home, 'work', 'agent-connect-acceptance-' + m.runId) || m.skillDir !== path.join(loc.data, 'skills', m.skillName)) throw new Error('Unexpected fixture paths');
const receipt = { cleanupPass: false, mcpRemoved: false, skillRemoved: false, removedMemories: [], memoryResults: [], conflicts: [], evidencePreservedAt: m.workspaceRoot };
const conflict = (kind, identity, code) => receipt.conflicts.push({ kind, ...identity, code });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fail(code) { throw Object.assign(new Error(code), { code }); }
function checkedStat(file) {
  // Check every ancestor, including the data root; lstat never follows a link.
  let current = path.parse(path.resolve(file)).root;
  let stat;
  for (const part of path.resolve(file).slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return null;
    if (stat.isSymbolicLink()) fail('SKILL_SYMLINK');
    if (current !== path.resolve(file) && !stat.isDirectory()) fail('SKILL_ANCESTOR_NOT_DIRECTORY');
  }
  return stat;
}
try {
  const configFile = path.join(loc.data, 'mcp.json'), config = readJSON(configFile);
  if (Object.hasOwn(config.mcpServers || {}, m.fixtureMcpName)) {
    if (digest(config.mcpServers[m.fixtureMcpName]) !== m.mcpEntryHash) fail('MCP_ENTRY_CHANGED');
    delete config.mcpServers[m.fixtureMcpName]; saveJSON(configFile, config); receipt.mcpRemoved = true;
  }
} catch (error) { conflict('mcp', { name: m.fixtureMcpName }, error.code || 'MCP_CLEANUP_FAILED'); }
try {
  const directory = checkedStat(m.skillDir);
  if (directory) {
    if (!directory.isDirectory()) fail('SKILL_NOT_DIRECTORY');
    const skill = path.join(m.skillDir, 'SKILL.md');
    // Reconstruct the exact creation bytes for existing manifests. Never adopt
    // current disk contents as ownership evidence or rely on a nonce substring.
    const expected = Buffer.from(`---\nname: ${m.skillName}\ndescription: Use when asked to run the ${m.runId} shared resource acceptance probe.\n---\n\nRead this skill and report its exact marker: ${m.expectedSkill}\n`);
    const validate = () => {
      const dir = checkedStat(m.skillDir), file = checkedStat(skill);
      if (!dir?.isDirectory() || dir.dev !== directory.dev || dir.ino !== directory.ino) fail('SKILL_DIRECTORY_CHANGED');
      if (JSON.stringify(fs.readdirSync(m.skillDir).sort()) !== '["SKILL.md"]') fail('SKILL_TREE_CHANGED');
      if (!file?.isFile() || file.nlink !== 1) fail('SKILL_NOT_EXCLUSIVE_FILE');
      if (hash(fs.readFileSync(skill)) !== hash(expected)) fail('SKILL_CONTENT_CHANGED');
      return file;
    };
    const before = validate(), after = validate();
    if (before.dev !== after.dev || before.ino !== after.ino) fail('SKILL_FILE_CHANGED');
    // No recursive removal: an unexpected tree member is never removed.
    fs.unlinkSync(skill); fs.rmdirSync(m.skillDir); receipt.skillRemoved = true;
  }
} catch (error) { conflict('skill', { path: m.skillDir }, error.code || 'SKILL_CLEANUP_FAILED'); }
// A key may have multiple accepted or attempted markers. Array order does not
// establish which write is current; read it and use that exact revision for CAS.
const ownedMemories = new Map();
for (const write of [{ key: m.localMemoryKey, marker: m.expectedMemory }, ...(m.attemptedWrites || []), ...(m.writes || [])]) {
  if (typeof write.key !== 'string' || typeof write.marker !== 'string') {
    conflict('memory', {}, 'INVALID_OWNED_WRITE'); continue;
  }
  if (!ownedMemories.has(write.key)) ownedMemories.set(write.key, new Set());
  ownedMemories.get(write.key).add(write.marker);
}
for (const [key, markers] of ownedMemories) {
  const result = { key };
  receipt.memoryResults.push(result);
  try {
    const memory = memoryRead(loc, key);
    if (!memory) { result.status = 'absent'; continue; }
    result.readRevision = memory.revision;
    if (!markers.has(memory.content)) fail('MEMORY_CONTENT_CHANGED');
    result.expectedRevision = memory.revision;
    await memoryDelete(loc, { key, expectedRevision: memory.revision });
    result.status = 'deleted'; receipt.removedMemories.push(key);
  } catch (error) {
    result.status = 'conflict'; result.code = error.code || 'MEMORY_CLEANUP_FAILED';
    conflict('memory', { key, ...(result.readRevision ? { readRevision: result.readRevision } : {}) }, result.code);
  }
}
// A conflicting skill tree must not be traversed by the resource scanner.
if (receipt.conflicts.length === 0) {
  try { await synchronize({ cwd: loc.home, loc }); receipt.synchronized = true; }
  catch (error) { conflict('sync', {}, error.code || 'SYNCHRONIZE_FAILED'); }
} else receipt.synchronized = false;
receipt.cleanupPass = receipt.conflicts.length === 0;
console.log(JSON.stringify(receipt));
if (!receipt.cleanupPass) process.exitCode = 1;
