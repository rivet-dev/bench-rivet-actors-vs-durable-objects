#!/usr/bin/env bash
# Deploys the Durable Object bench Worker and runs the whole series from the runner VM, so the
# client sits in the same Azure region as the Rivet cluster. Results land in
# /opt/rivet/cf/results on the runner (scripts/collect.sh copies them home); the in-DO wall
# times then come from scripts/cf-analytics.sh, which needs the local wrangler login.
#
# Usage: scripts/run-cloudflare.sh <run-name>
# Requires a wrangler login on this machine (`pnpm exec wrangler login` in cloudflare/).
source "$(dirname "$0")/lib.sh"

run=${1:?run name}
load_outputs
cd "$ROOT/cloudflare"
pnpm install --frozen-lockfile --silent
deploy=$(pnpm exec wrangler deploy 2>&1 | tee /dev/stderr)
url=$(echo "$deploy" | grep -o -E 'https://[a-z0-9.-]+\.workers\.dev' | head -1)
[[ -n $url ]] || { echo "could not find the Worker URL in the deploy output" >&2; exit 1; }
echo "$url" > "$LOCAL/cf-worker-url"

rssh "$RUNNER_IP" "mkdir -p /opt/rivet/cf"
rrsync --exclude node_modules --exclude .wrangler --exclude results "$ROOT/cloudflare/" "$ADMIN_USER@$RUNNER_IP:/opt/rivet/cf/"
rssh "$RUNNER_IP" "export PATH=/opt/rivet/node/bin:\$PATH; cd /opt/rivet/cf && pnpm install --frozen-lockfile --silent"

remote() {
	rssh "$RUNNER_IP" "export PATH=/opt/rivet/node/bin:\$PATH NO_TAIL=1 BENCH_URL=$url RESULTS_DIR=/opt/rivet/cf/results/$run; cd /opt/rivet/cf && $*"
}
echo "start $(date -u +%FT%TZ)"
remote "node run.mjs clock"
remote "node run.mjs prepare w1 200"
remote "node run.mjs prepare w2 200"
prepared_at=$(date +%s)
remote "node run.mjs create 200"
remote "node run.mjs sql 300"
remote "node run.mjs burst 500 1,8,32,128"
remote "node run.mjs seqwrite 2000"
# The wake sets must idle at least ten minutes (a DO is evicted after about ten seconds idle;
# the longer wait keeps this comparable to the earlier runs and lets storage go quiet).
while (( $(date +%s) - prepared_at < 600 )); do sleep 10; done
remote "node run.mjs wake w1 read"
remote "node run.mjs wake w2 write"
echo "all done $(date -u +%FT%TZ)"
