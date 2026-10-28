#!/usr/bin/env bash
# Runs the whole Rivet suite on the runner VM, one scenario after another, and leaves the raw
# samples under /opt/rivet/results/<run> there (scripts/collect.sh copies them home).
#
# Usage: scripts/run-rivet.sh <run-name> [scenario ...]
# Without scenario names every group runs with its default sample size.
source "$(dirname "$0")/lib.sh"

run=${1:?run name}
shift
load_outputs

remote() {
	rssh "$RUNNER_IP" "source /opt/rivet/bench.env && cd /opt/rivet/bench && mkdir -p /opt/rivet/results/$run && $*"
}

bench() {
	local name=$1
	shift
	echo "== $name: $* ($(date -u +%FT%TZ))"
	remote "node bench.mjs $* --out /opt/rivet/results/$run --prefix $name" | { grep -v -E '^(create|wake|prepare|sleep|warm|read|write|scan|probe): [0-9]+/[0-9]+$' || true; }
}

# A warmup create batch is excluded from the results (fresh runner process, JIT, caches).
all=(warmup warm create create-first create-write wake wake-read wake-write wake120 sql-read sql-write-woken sql-scan write-tput-woken burst hold)
groups=("${@:-${all[@]}}")
for g in "${groups[@]}"; do
	case $g in
		warmup) bench warmup create --n 300 --gap-ms 5 --actor benchPing ;;
		warm) bench warm warm --n 2000 --actors 10 ;;
		warm-getorcreate) bench warm-getorcreate warm --n 2000 --actors 10 --method getOrCreate ;;
		create) bench create create --n 1500 --gap-ms 20 --first ping ;;
		create-first) bench create-first create --n 1200 --gap-ms 20 --first first ;;
		create-write) bench create-write create --n 1200 --gap-ms 20 --first write ;;
		wake) bench wake wake --n 1200 --idle-s 10 --first ping --gap-ms 20 ;;
		wake-read) bench wake-read wake --n 1200 --idle-s 10 --first read --gap-ms 20 ;;
		wake-write) bench wake-write wake --n 1200 --idle-s 10 --first write --gap-ms 20 ;;
		wake120) bench wake120 wake --n 1000 --idle-s 120 --first ping --gap-ms 20 ;;
		sql-read) bench sql-read sql-read --n 1200 --rows 1000 ;;
		sql-scan) bench sql-scan sql-scan --n 1000 --rows 1000 ;;
		sql-write-woken) bench sql-write-woken sql-write --n 1200 ;;
		write-tput-woken) bench write-tput-woken sql-write --n 5000 ;;
		burst) bench burst burst --concurrency 1,8,32,128 --per 500 ;;
		hold) bench hold hold --steps 0,1000,10000 --rss-cmd "'bash /opt/rivet/bench/rss.sh'" ;;
		*) echo "unknown group $g" >&2; exit 1 ;;
	esac
done
# Versions and placement, for the record.
remote "node --version > /opt/rivet/results/$run/node-version.txt; cat /opt/rivet/app/node_modules/rivetkit/package.json | jq -r .version > /opt/rivet/results/$run/rivetkit-version.txt"
rssh "${STORAGE_PUBLIC_IPS[0]}" "/opt/rivet/bin/rivet-engine --version; sha256sum /opt/rivet/bin/rivet-engine; RUST_LOG=error /opt/rivet/bin/rivet-engine --config /opt/rivet/operator.json storage partition show | grep -v '^ts='" > "$LOCAL/run-$run-engine.txt"
echo "run $run finished $(date -u +%FT%TZ)"
