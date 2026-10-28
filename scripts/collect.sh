#!/usr/bin/env bash
# Copies raw results from the runner VM into results/<date>/ in the repository.
#
# Usage: scripts/collect.sh <run-name> [<date-dir>]
source "$(dirname "$0")/lib.sh"

run=${1:?run name}
date_dir=${2:-$(date -u +%Y-%m-%d)}
load_outputs
dest="$ROOT/results/$date_dir/rivet"
mkdir -p "$dest"
rrsync "$ADMIN_USER@$RUNNER_IP:/opt/rivet/results/$run/" "$dest/"
if [[ -f $LOCAL/run-$run-engine.txt ]]; then
	cp "$LOCAL/run-$run-engine.txt" "$dest/engine-version-and-placement.txt"
fi
# Hardware facts of the VMs, without addresses.
for i in "${!STORAGE_PUBLIC_IPS[@]}"; do
	rssh "${STORAGE_PUBLIC_IPS[$i]}" "echo zone ${STORAGE_ZONES[$i]}; lscpu | grep -E 'Model name|^CPU\(s\)'; free -g | head -2; uname -r; findmnt -no SOURCE,FSTYPE,OPTIONS /mnt/nvme; lsblk -dn -o NAME,SIZE,MODEL | grep nvme" > "$dest/hardware-storage-z${STORAGE_ZONES[$i]}.txt"
done
rssh "$RUNNER_IP" "lscpu | grep -E 'Model name|^CPU\(s\)'; free -g | head -2; uname -r" > "$dest/hardware-runner.txt"
# Private addresses in file names and contents become role labels, so results can be committed.
scrub() {
	local dir=$1 i label
	for i in "${!STORAGE_PRIVATE_IPS[@]}"; do
		label="storage-z${STORAGE_ZONES[$i]}"
		find "$dir" -depth -name "*${STORAGE_PRIVATE_IPS[$i]}*" -exec bash -c 'mv "$1" "${1//$2/$3}"' _ {} "${STORAGE_PRIVATE_IPS[$i]}" "$label" \;
		find "$dir" -type f \( -name '*.json' -o -name '*.ndjson' -o -name '*.txt' \) -exec sed -i "s/${STORAGE_PRIVATE_IPS[$i]}/$label/g" {} +
	done
	find "$dir" -type f \( -name '*.json' -o -name '*.ndjson' -o -name '*.txt' \) -exec sed -i "s/$RUNNER_PRIVATE_IP/runner/g" {} +
}
scrub "$dest"
echo "collected into $dest"
ls "$dest" | head -50
# Cloudflare results of the same run name, if the series ran.
if rssh "$RUNNER_IP" "test -d /opt/rivet/cf/results/$run"; then
	cfdest="$ROOT/results/$date_dir/cloudflare"
	mkdir -p "$cfdest"
	rrsync "$ADMIN_USER@$RUNNER_IP:/opt/rivet/cf/results/$run/" "$cfdest/"
	scrub "$cfdest"
	echo "collected Cloudflare results into $cfdest"
fi
