#!/usr/bin/env bash
# Initial installation on a fresh Debian/Ubuntu VPS; API keys never enter Git.
set +x
set -euo pipefail

deploy_revision=ca01c0775518aa91d4d30f84a3a66294b3665770
deploy_root=/opt/mrbeast
deploy_state=/var/lib/mrbeast
deploy_config=/etc/mrbeast
deploy_source=${MRBEAST_SOURCE_DIR:-}
deploy_database=${MRBEAST_INITIAL_DATABASE:-}
deploy_host=${MRBEAST_PUBLIC_HOST:-194.87.26.147}
deploy_check=false
if [[ ${1:-} == --check ]]; then deploy_check=true; shift; fi
if (( $# )); then printf 'Usage: bash deploy-vps.sh [--check]\n' >&2; exit 1; fi

deploy_fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ -r /etc/os-release ]] || deploy_fail 'Cannot identify the server OS.'
# shellcheck disable=SC1091
. /etc/os-release
case ${ID:-} in ubuntu|debian) ;; *) deploy_fail 'This installer supports Ubuntu and Debian only.' ;; esac
case $(uname -m) in x86_64) deploy_arch=x64 ;; aarch64) deploy_arch=arm64 ;; *) deploy_fail 'Unsupported CPU architecture.' ;; esac
[[ $(cat /proc/1/comm) == systemd ]] || deploy_fail 'A server running systemd is required.'
[[ $deploy_host =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || deploy_fail 'Invalid MRBEAST_PUBLIC_HOST.'
command -v ss >/dev/null || deploy_fail 'The ss command is required for the port check.'
[[ -z $(ss -H -ltn 'sport = :80') ]] || deploy_fail 'Port 80 is already in use. Existing services have not been changed.'
for deploy_path in "$deploy_root" "$deploy_state" "$deploy_config" /etc/systemd/system/mrbeast.service; do
  [[ ! -e $deploy_path && ! -L $deploy_path ]] || deploy_fail "Existing deployment path: $deploy_path. No overwrite will be performed."
done
if id mrbeast >/dev/null 2>&1; then deploy_fail 'The mrbeast user already exists. Inspect the server before installation.'; fi
if [[ -n $deploy_source ]]; then
  [[ -f $deploy_source/src/index.ts && -f $deploy_source/package-lock.json && -f $deploy_source/.node-version ]] || deploy_fail 'MRBEAST_SOURCE_DIR is not a project checkout.'
fi
if [[ -n $deploy_database ]]; then [[ -f $deploy_database ]] || deploy_fail 'MRBEAST_INITIAL_DATABASE is not a file.'; fi
printf 'OS: %s; architecture: %s; application: %s; data: %s; HTTP port: 80\n' "$PRETTY_NAME" "$deploy_arch" "$deploy_root" "$deploy_state"
if $deploy_check; then printf 'Preflight checks passed; no installation performed.\n'; exit 0; fi
[[ $(id -u) == 0 ]] || deploy_fail 'Run this installer as root in the server console.'
[[ -r /dev/tty ]] || deploy_fail 'An interactive console is required for secure API-key entry.'

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl git xz-utils
deploy_tmp=$(mktemp -d /tmp/mrbeast-install.XXXXXXXX)
trap 'rm -rf -- "$deploy_tmp"' EXIT
if [[ -z $deploy_source ]]; then
  deploy_source=$deploy_tmp/source
  git init -q "$deploy_source"
  git -C "$deploy_source" fetch --depth=1 https://github.com/asbelov2/youtube-mr-beast-views-parser.git "$deploy_revision"
  git -C "$deploy_source" checkout -q --detach FETCH_HEAD
  [[ $(git -C "$deploy_source" rev-parse HEAD) == "$deploy_revision" ]] || deploy_fail 'Unexpected application revision.'
fi
deploy_node_version=$(tr -d '\r\n' < "$deploy_source/.node-version")
[[ $deploy_node_version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || deploy_fail 'Invalid .node-version.'
deploy_node_archive=node-v${deploy_node_version}-linux-${deploy_arch}.tar.xz
deploy_node_url=https://nodejs.org/dist/v${deploy_node_version}
curl --fail --silent --show-error --location --proto '=https' "$deploy_node_url/SHASUMS256.txt" -o "$deploy_tmp/SHASUMS256.txt"
curl --fail --silent --show-error --location --proto '=https' "$deploy_node_url/$deploy_node_archive" -o "$deploy_tmp/$deploy_node_archive"
awk -v archive="$deploy_node_archive" '$2 == archive { print }' "$deploy_tmp/SHASUMS256.txt" > "$deploy_tmp/node.sha256"
[[ -s $deploy_tmp/node.sha256 ]] || deploy_fail 'Official Node checksum is missing.'
(cd "$deploy_tmp" && sha256sum --check --strict node.sha256)

mkdir -p "$deploy_root/app" "$deploy_root/node"
tar -xJf "$deploy_tmp/$deploy_node_archive" -C "$deploy_root/node" --strip-components=1
deploy_node=$deploy_root/node/bin/node
deploy_node_path=$deploy_root/node/bin:/usr/bin:/bin
"$deploy_node" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 24 || (major === 24 && minor < 19)) process.exit(1);'
# Copy only project inputs; an existing local .env or database is never copied implicitly.
for deploy_entry in src scripts tests package.json package-lock.json tsconfig.json tsconfig.test.json .node-version; do
  cp -a -- "$deploy_source/$deploy_entry" "$deploy_root/app/"
done
useradd --system --user-group --home-dir "$deploy_state" --no-create-home --shell /usr/sbin/nologin mrbeast
install -d -m 0750 -o mrbeast -g mrbeast "$deploy_state"
chown -R mrbeast:mrbeast "$deploy_root/app"
(
  cd "$deploy_root/app"
  runuser -u mrbeast -- env PATH="$deploy_node_path" npm ci --no-audit --no-fund --cache "$deploy_state/npm-cache"
  runuser -u mrbeast -- env PATH="$deploy_node_path" npm run check
)
chown -R root:root "$deploy_root/app"

if [[ -n $deploy_database ]]; then
  "$deploy_node" --input-type=module - "$deploy_database" <<'JS'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2], { readOnly: true });
try {
  if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Invalid SQLite backup');
  db.prepare('SELECT id, channel_id, published_at FROM videos LIMIT 1').all();
  db.prepare('SELECT video_id, observed_at, view_count FROM view_snapshots LIMIT 1').all();
} finally { db.close(); }
JS
  [[ ! -e ${deploy_database}-wal ]] || deploy_fail 'Supply a consistent SQLite backup, not a live database with WAL.'
  install -m 0640 -o mrbeast -g mrbeast "$deploy_database" "$deploy_state/mrbeast.sqlite"
fi

IFS= read -r -s -p 'YouTube Data API key (hidden input): ' deploy_api_key < /dev/tty
printf '\n' > /dev/tty
[[ $deploy_api_key =~ ^[A-Za-z0-9_-]+$ ]] || deploy_fail 'The API key must be nonempty and contain only letters, digits, underscores and hyphens.'
install -d -m 0700 "$deploy_config"
umask 077
{
  printf 'YOUTUBE_API_KEY=%s\n' "$deploy_api_key"
  printf '%s\n' 'YOUTUBE_CHANNEL_IDS=UCX6OQ3DkcsbYNE6H8uQQuVA,UCIPPMRA040LQr5QPyJEbmXA' 'TRACKING_WINDOW_DAYS=14' 'POLL_INTERVAL_MINUTES=5' 'FULL_DISCOVERY_INTERVAL_MINUTES=60' 'DATABASE_PATH=/var/lib/mrbeast/mrbeast.sqlite' 'WEB_HOST=0.0.0.0' 'WEB_PORT=80'
} > "$deploy_config/collector.env"
unset deploy_api_key
umask 022
cat > /etc/systemd/system/mrbeast.service <<'UNIT'
[Unit]
Description=MrBeast and MrBeast Gaming view statistics
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=mrbeast
Group=mrbeast
WorkingDirectory=/opt/mrbeast/app
EnvironmentFile=/etc/mrbeast/collector.env
ExecStart=/opt/mrbeast/node/bin/node --use-env-proxy /opt/mrbeast/app/dist/index.js
Restart=on-failure
RestartSec=10s
TimeoutStopSec=30s
StateDirectory=mrbeast
StateDirectoryMode=0750
UMask=0027
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/mrbeast

[Install]
WantedBy=multi-user.target
UNIT
if command -v ufw >/dev/null; then
  case $(LC_ALL=C ufw status) in *'Status: active'*) ufw allow 80/tcp ;; esac
fi
deploy_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
systemctl daemon-reload
systemctl enable --now mrbeast.service
deploy_ready=false
for ((deploy_attempt=0; deploy_attempt<90; deploy_attempt++)); do
  if ! systemctl is-active --quiet mrbeast.service; then
    journalctl -u mrbeast.service --since "$deploy_started" --no-pager -o cat
    deploy_fail 'The application did not stay running; inspect the service journal.'
  fi
  set +e
  "$deploy_node" --input-type=module - "$deploy_started" <<'JS'
import { execFileSync } from 'node:child_process';
const text = execFileSync('journalctl', ['-u', 'mrbeast.service', '--since', process.argv[2], '--no-pager', '-o', 'cat'], { encoding: 'utf8' });
const events = text.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const failed = events.find(event => event.event === 'collection_failed');
if (failed) { console.error(JSON.stringify(failed)); process.exit(2); }
const complete = new Set(events.filter(event => event.event === 'collection_completed').map(event => event.channelId));
process.exit(['UCX6OQ3DkcsbYNE6H8uQQuVA', 'UCIPPMRA040LQr5QPyJEbmXA'].every(id => complete.has(id)) ? 0 : 1);
JS
  deploy_status=$?
  set -e
  if (( deploy_status == 2 )); then deploy_fail 'Collection failed. Check the API key and YouTube Data API access; the service remains installed.'; fi
  if (( deploy_status == 0 )); then deploy_ready=true; break; fi
  sleep 2
done
$deploy_ready || deploy_fail 'Initial collection is not confirmed yet. Check: journalctl -u mrbeast -n 30 --no-pager'
curl --fail --silent --show-error --noproxy '*' http://127.0.0.1/api/videos -o "$deploy_state/startup-check.json"
"$deploy_node" --input-type=module - "$deploy_state/startup-check.json" <<'JS'
import { readFileSync } from 'node:fs';
const data = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (!Array.isArray(data.videos) || data.pollIntervalMinutes !== 5 || data.retentionDays !== 28) throw new Error('Unexpected dashboard response');
console.log('Both channels collected successfully; saved videos: ' + data.videos.length);
JS
systemctl is-enabled --quiet mrbeast.service
printf 'Installation verified locally. Open http://%s/ (allow incoming TCP 80 in Timeweb if needed).\n' "$deploy_host"
