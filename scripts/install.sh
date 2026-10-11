#!/usr/bin/env bash
# Authentication is provided by the caller's git credential helper / SSH agent.
set -euo pipefail

fail() { printf 'Pi Paseo bootstrap failed: %s\n' "$1" >&2; exit 1; }
for command in git node npm pi; do command -v "$command" >/dev/null 2>&1 || fail "missing $command"; done
[ -n "${HOME:-}" ] && [ -d "$HOME" ] && [ -w "$HOME" ] || fail 'persistent writable HOME required'
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)' || fail 'Node >=22.19.0 required'

source_root=''
if [ "$#" -gt 0 ]; then
  [ "$#" -eq 2 ] && [ "$1" = '--source' ] || fail 'usage: install.sh [--source PINNED_CHECKOUT]'
  source_root="$2"
fi
script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
plugin_ref="${PI_PASEO_REF:-}"
if [ -z "$plugin_ref" ]; then
  plugin_ref="$(git -C "${source_root:-$script_root}" rev-parse HEAD 2>/dev/null)" || fail 'PI_PASEO_REF must be the release full commit SHA'
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
  [ "$(git -C "$source_root" rev-parse HEAD 2>/dev/null)" = "$plugin_ref" ] || fail 'source checkout does not match PI_PASEO_REF'
  git clone --quiet --no-hardlinks --no-checkout -- "$source_root" "$stage" >/dev/null 2>&1 || fail 'cannot copy pinned checkout'
  git -C "$stage" remote set-url origin "$repository" >/dev/null 2>&1 || fail 'cannot set repository origin'
else
  git -C "$stage" init --quiet >/dev/null 2>&1 || fail 'git init failed'
  git -C "$stage" remote add origin "$repository" >/dev/null 2>&1 || fail 'git remote failed'
  git -C "$stage" fetch --quiet --depth=1 origin "$plugin_ref" >/dev/null 2>&1 || fail 'git fetch failed; check external git authentication and release commit'
fi
git -C "$stage" checkout --quiet --detach "$plugin_ref" >/dev/null 2>&1 || fail 'pinned checkout failed'
[ "$(git -C "$stage" rev-parse HEAD 2>/dev/null)" = "$plugin_ref" ] || fail 'release commit mismatch'
node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1]));if(p.name!=="@woowtech/pi-paseo")process.exit(1)' "$stage/package.json" >/dev/null 2>&1 || fail 'unexpected package'

# Keep each source path immutable: Pi local packages keep this exact path.
source_install="$install_root/$plugin_ref"
if [ -e "$source_install" ] || [ -L "$source_install" ]; then
  [ ! -L "$source_install" ] || fail 'linked package destination'
  [ "$(git -C "$source_install" rev-parse HEAD 2>/dev/null)" = "$plugin_ref" ] || fail 'existing package revision mismatch'
  [ -z "$(git -C "$source_install" status --porcelain --untracked-files=normal 2>/dev/null)" ] || fail 'existing package has local changes; preserve them and use a clean release'
else
  mv -- "$stage" "$source_install"
fi
# CI/review can opt out explicitly. Bootstrap uses the explicit lifecycle after
# registration, so it does not rely on local-path pi install running npm hooks.
(cd -- "$source_install" && PI_PASEO_SKIP_POSTINSTALL=1 npm ci --include=dev --no-audit --no-fund) >/dev/null 2>&1 || fail 'locked package dependency install failed'
pi install "$source_install" >/dev/null 2>&1 || fail 'Pi package registration failed'
node "$source_install/bin/install-host.mjs" || fail 'host adapter preparation failed'
node "$source_install/bin/cli.mjs" install || fail 'managed Paseo activation failed'
printf 'Installed source: %s\nPi Web restart is pending; restart it manually through its existing service/launcher.\n' "$source_install"
