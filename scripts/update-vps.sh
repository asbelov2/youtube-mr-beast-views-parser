#!/usr/bin/env bash
# Update an installation made by deploy-vps.sh, keeping SQLite and its API key.
set +x
set -euo pipefail
update_fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ $(id -u) == 0 ]] || update_fail 'Run this script as root on the VPS.'
update_root=/opt/mrbeast
update_source=${MRBEAST_SOURCE_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}
update_port=${MRBEAST_WEB_PORT:-80}
[[ $update_port =~ ^[1-9][0-9]{0,4}$ ]] && (( update_port <= 65535 )) || update_fail 'Invalid MRBEAST_WEB_PORT.'
[[ -d $update_root/app && -x $update_root/node/bin/node ]] || update_fail 'Existing deploy-vps.sh installation not found.'
[[ $(systemctl show mrbeast.service --property=WorkingDirectory --value) == "$update_root/app" ]] || update_fail 'The service uses a different working directory; inspect it before updating.'
[[ -f $update_source/package-lock.json && -f $update_source/src/index.ts ]] || update_fail 'MRBEAST_SOURCE_DIR is not a project checkout.'
[[ $(realpath "$update_source") != "$update_root/app" ]] || update_fail 'Run from a separate checkout, not the active application directory.'
[[ ! -e $update_root/app/data && ! -e $update_root/app/.env ]] || update_fail 'Runtime files exist inside the application directory; inspect them before switching code.'
umask 022
update_tmp=$(mktemp -d "$update_root/update.XXXXXXXX")
chmod 0755 "$update_tmp"
update_backup=
update_stopped=false
update_moved=false
update_done=false
cleanup() {
  local update_exit=$?
  trap - EXIT
  set +e
  if $update_stopped && ! $update_done; then
    systemctl stop mrbeast.service
    if $update_moved; then
      if [[ -e $update_root/app ]]; then mv -- "$update_root/app" "$update_tmp/failed-app"; fi
      if ! mv -- "$update_backup/app" "$update_root/app"; then
        printf 'Restore failed. Previous code is in %s/app; database and key are unchanged.\n' "$update_backup" >&2
        exit 1
      fi
    fi
    systemctl start mrbeast.service
    printf 'Update failed; previous application code restored.\n' >&2
  fi
  rm -rf -- "$update_tmp"
  exit "$update_exit"
}
trap cleanup EXIT
mkdir "$update_tmp/app"
for update_entry in src scripts tests package.json package-lock.json tsconfig.json tsconfig.test.json .node-version; do
  cp -a -- "$update_source/$update_entry" "$update_tmp/app/"
done
chown -R mrbeast:mrbeast "$update_tmp/app"
(
  cd "$update_tmp/app"
  runuser -u mrbeast -- env PATH="$update_root/node/bin:/usr/bin:/bin" npm ci --no-audit --no-fund --cache /var/lib/mrbeast/npm-cache
  runuser -u mrbeast -- env PATH="$update_root/node/bin:/usr/bin:/bin" npm run check
)
chown -R root:root "$update_tmp/app"
update_backup=$(mktemp -d "$update_root/previous.XXXXXXXX")
chmod 0755 "$update_backup"
systemctl stop mrbeast.service
update_stopped=true
mv -- "$update_root/app" "$update_backup/app"
update_moved=true
mv -- "$update_tmp/app" "$update_root/app"
systemctl start mrbeast.service
update_ready=false
for ((update_attempt=0; update_attempt<30; update_attempt++)); do
  if systemctl is-active --quiet mrbeast.service && curl --fail --silent --noproxy '*' "http://127.0.0.1:$update_port/api/videos" -o "$update_tmp/health.json"; then
    update_ready=true; break
  fi
  sleep 1
done
$update_ready || update_fail 'Updated service did not become ready.'
"$update_root/node/bin/node" --input-type=module - "$update_tmp/health.json" "$update_port" <<'JS'
import { readFileSync } from 'node:fs';
const data = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (!Array.isArray(data.videos)) throw new Error('Invalid dashboard response');
if (data.videos.length) {
  const response = await fetch(`http://127.0.0.1:${process.argv[3]}/api/videos/${encodeURIComponent(data.videos[0].id)}?compareHours=13&forecastHours=1`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok || !(await response.json()).dayComparison) throw new Error('Updated comparison endpoint is unavailable');
}
console.log('Updated dashboard verified; saved videos: ' + data.videos.length);
JS
systemctl is-active --quiet mrbeast.service
update_done=true
printf 'Update complete. Previous code: %s/app. SQLite and API configuration are preserved.\n' "$update_backup"
