#!/usr/bin/env bash
# Prints resident memory (KiB) of the RivetKit node on this VM and of every Engine on the
# storage hosts, as one JSON object, for the hold scenario's --rss-cmd.
set -euo pipefail
hosts=$(cat "${STORAGE_HOSTS_FILE:-/opt/rivet/storage-hosts}")
ssh_opts=(-i /opt/rivet/bench_key -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/opt/rivet/known_hosts -o ConnectTimeout=10)
node_rss=$(ps -o rss= -p "$(systemctl show -p MainPID --value rivet-node)" | tr -d ' ')
parts=()
for h in $hosts; do
	rss=$(ssh "${ssh_opts[@]}" "rivet@$h" 'ps -o rss= -p "$(systemctl show -p MainPID --value rivet-engine)"' | tr -d ' ')
	parts+=("\"$h\": ${rss:-0}")
done
echo "{\"node\": ${node_rss:-0}, \"storage\": {$(IFS=,; echo "${parts[*]}")}}"
