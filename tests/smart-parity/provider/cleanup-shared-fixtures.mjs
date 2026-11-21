import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [manifestPath, mode] = process.argv.slice(2);
if (mode !== '--execute') throw new Error('Cleanup requires explicit manifest path and --execute');
const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const { locations, readJSON, saveJSON, digest } = await import(pathToFileURL(path.join(m.root, 'src/common.mjs')));
const { memoryRead, memoryDelete } = await import(pathToFileURL(path.join(m.root, 'src/memory.mjs')));
const { synchronize } = await import(pathToFileURL(path.join(m.root, 'src/sync.mjs')));
const loc = locations();
if (m.workspaceRoot !== path.join(loc.home, 'work', 'agent-connect-acceptance-' + m.runId) || m.skillDir !== path.join(loc.data, 'skills', m.skillName)) throw new Error('Unexpected fixture paths');
const configFile = path.join(loc.data, 'mcp.json'), config = readJSON(configFile);
let mcpRemoved = false;
if (config.mcpServers?.[m.fixtureMcpName] && digest(config.mcpServers[m.fixtureMcpName]) === m.mcpEntryHash) { delete config.mcpServers[m.fixtureMcpName]; saveJSON(configFile, config); mcpRemoved = true; }
let skillRemoved = false;
const skill = path.join(m.skillDir, 'SKILL.md');
if (fs.existsSync(skill) && fs.readFileSync(skill, 'utf8').includes(m.expectedSkill)) { fs.rmSync(m.skillDir, { recursive: true }); skillRemoved = true; }
const removedMemories = [];
const ownedMemories = new Map([[m.localMemoryKey, m.expectedMemory], ...(m.attemptedWrites || []).map(w => [w.key, w.marker]), ...(m.writes || []).map(w => [w.key, w.marker])]);
for (const [key, marker] of ownedMemories) {
  const memory = memoryRead(loc, key);
  if (memory?.content === marker) { await memoryDelete(loc, { key, expectedRevision: memory.revision }); removedMemories.push(key); }
}
await synchronize({ cwd: loc.home, loc });
console.log(JSON.stringify({ mcpRemoved, skillRemoved, removedMemories, evidencePreservedAt: m.workspaceRoot }));
