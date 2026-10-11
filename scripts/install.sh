#!/usr/bin/env bash
# Authentication is provided by the caller's git credential helper / SSH agent.
set -euo pipefail

fail() { printf 'Pi Paseo bootstrap failed: %s\n' "$1" >&2; exit 1; }
for command in git node npm pi; do command -v "$command" >/dev/null 2>&1 || fail "missing $command"; done
script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
[ -f "$script_root/scripts/run-command.mjs" ] || fail 'bounded command helper missing; use the complete pinned checkout'
bounded_pid=''
bounded() {
  local result=0
  node "$script_root/scripts/run-command.mjs" "$@" <&0 &
  bounded_pid=$!
  wait "$bounded_pid" || result=$?
  bounded_pid=''
  return "$result"
}
interrupted() {
  trap '' INT TERM
  if [ -n "$bounded_pid" ]; then
    kill -TERM "$bounded_pid" 2>/dev/null || true
    wait "$bounded_pid" 2>/dev/null || true
  fi
  exit 130
}
trap interrupted INT TERM
[ -n "${HOME:-}" ] && [ -d "$HOME" ] && [ -w "$HOME" ] || fail 'persistent writable HOME required'
bounded node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)' || fail 'Node >=22.19.0 required'

source_root=''
if [ "$#" -gt 0 ]; then
  [ "$#" -eq 2 ] && [ "$1" = '--source' ] || fail 'usage: install.sh [--source PINNED_CHECKOUT]'
  source_root="$2"
fi
plugin_ref="${PI_PASEO_REF:-}"
if [ -z "$plugin_ref" ]; then
  plugin_ref="$(bounded git -C "${source_root:-$script_root}" rev-parse HEAD 2>/dev/null)" || fail 'PI_PASEO_REF must be the release full commit SHA'
fi
[[ "$plugin_ref" =~ ^[a-f0-9]{40}$ ]] || fail 'PI_PASEO_REF must be a full 40-character commit SHA'
repository="${PI_PASEO_REPOSITORY:-https://github.com/WOOWTECH/pi-paseo-plugin.git}"
case "$repository" in
  https://github.com/WOOWTECH/pi-paseo-plugin|https://github.com/WOOWTECH/pi-paseo-plugin.git|git@github.com:WOOWTECH/pi-paseo-plugin.git) ;;
  *) fail 'use the canonical HTTPS repository or SSH URL; credentials must remain external' ;;
esac

install_root="$HOME/.local/share/pi-paseo/plugin-sources"
# Reject linked storage components so installation cannot replace external data.
for component in "$HOME/.local" "$HOME/.local/share" "$HOME/.local/share/pi-paseo" "$install_root"; do
  [ ! -L "$component" ] || fail 'linked install storage is not supported'
done
mkdir -p -- "$install_root"
stage="$(mktemp -d "$install_root/.bootstrap-XXXXXX")"
trap 'rm -rf -- "$stage"' EXIT
if [ -n "$source_root" ]; then
  [ "$(bounded git -C "$source_root" rev-parse HEAD 2>/dev/null)" = "$plugin_ref" ] || fail 'source checkout does not match PI_PASEO_REF'
  bounded git clone --quiet --no-hardlinks --no-checkout -- "$source_root" "$stage" >/dev/null 2>&1 || fail 'cannot copy pinned checkout'
  bounded git -C "$stage" remote set-url origin "$repository" >/dev/null 2>&1 || fail 'cannot set repository origin'
else
  bounded git -C "$stage" init --quiet >/dev/null 2>&1 || fail 'git init failed'
  bounded git -C "$stage" remote add origin "$repository" >/dev/null 2>&1 || fail 'git remote failed'
  bounded git -C "$stage" fetch --quiet --depth=1 origin "$plugin_ref" >/dev/null 2>&1 || fail 'git fetch failed; check external git authentication and release commit'
fi
bounded git -C "$stage" checkout --quiet --detach "$plugin_ref" >/dev/null 2>&1 || fail 'pinned checkout failed'
[ "$(bounded git -C "$stage" rev-parse HEAD 2>/dev/null)" = "$plugin_ref" ] || fail 'release commit mismatch'
bounded node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1]));if(p.name!=="@woowtech/pi-paseo")process.exit(1)' "$stage/package.json" >/dev/null 2>&1 || fail 'unexpected package'

# Keep each source path immutable: Pi local packages keep this exact path.
source_install="$install_root/$plugin_ref"
if [ -e "$source_install" ] || [ -L "$source_install" ]; then
  [ ! -L "$source_install" ] || fail 'linked package destination'
  [ "$(bounded git -C "$source_install" rev-parse HEAD 2>/dev/null)" = "$plugin_ref" ] || fail 'existing package revision mismatch'
  local_changes="$(bounded git -C "$source_install" status --porcelain --untracked-files=normal 2>/dev/null)" || fail 'cannot inspect existing package'
  [ -z "$local_changes" ] || fail 'existing package has local changes; preserve them and use a clean release'
  bounded --stdin node --input-type=module - "$source_install" "$plugin_ref" <<'NODE' || fail 'existing source dependencies are incomplete; preserve it and install a clean release'
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const [root, ref] = process.argv.slice(2);
try {
  const directory = path.join(root, 'node_modules'), file = path.join(directory, '.pi-paseo-bootstrap.json');
  if (!fs.lstatSync(directory).isDirectory() || !fs.lstatSync(file).isFile()) process.exit(1);
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  const lock = createHash('sha256').update(fs.readFileSync(path.join(root, 'package-lock.json'))).digest('hex');
  if (receipt.ref !== ref || receipt.lockSha256 !== lock || receipt.nodeAbi !== process.versions.modules ||
      receipt.platform !== process.platform || receipt.arch !== process.arch) process.exit(1);
} catch { process.exit(1); }
NODE
else
  # Prepare all dependencies before publishing the path used by Pi. Re-running
  # npm ci in an already registered source would remove its live dependencies.
  pushd "$stage" >/dev/null
  NODE_ENV=development npm_config_production=false NPM_CONFIG_PRODUCTION=false PI_PASEO_SKIP_POSTINSTALL=1 bounded npm ci --include=dev --no-audit --no-fund >/dev/null 2>&1 || fail 'locked package dependency install failed'
  popd >/dev/null
  bounded --stdin node --input-type=module - "$stage" "$source_install" "$plugin_ref" <<'NODE' || fail 'source publication failed; retry after any concurrent installation completes'
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const [stage, destination, ref] = process.argv.slice(2);
try {
  const lockSha256 = createHash('sha256').update(fs.readFileSync(path.join(stage, 'package-lock.json'))).digest('hex');
  fs.writeFileSync(path.join(stage, 'node_modules/.pi-paseo-bootstrap.json'), JSON.stringify({
    ref, lockSha256, nodeAbi: process.versions.modules, platform: process.platform, arch: process.arch,
  }) + '\n', { flag: 'wx', mode: 0o600 });
  // rename refuses an existing nonempty release directory. Unlike mv, it can
  // never nest this staging checkout inside a concurrently published release.
  fs.renameSync(stage, destination);
} catch { process.exit(1); }
NODE
fi
# CI/review can opt out explicitly. Bootstrap uses the explicit lifecycle after
# registration, so it does not rely on local-path pi install running npm hooks.
bounded pi install "$source_install" >/dev/null 2>&1 || fail 'Pi package registration failed'
# Use the install lifecycle, which preserves a persisted pause. The explicit
# enable action behind `cli install` would resume a manually stopped service.
PI_PASEO_SKIP_POSTINSTALL=0 bounded node "$source_install/bin/cli.mjs" postinstall || fail 'host adapter and managed Paseo preparation failed'
printf 'Installed source: %s\nPi Web restart is pending; restart it manually through its existing service/launcher.\n' "$source_install"
