#!/usr/bin/env bash
# Pulls Cloudflare's own invocation wall times (Worker and inside the DO) for every block window
# of the collected Cloudflare results, through the GraphQL analytics API with the local wrangler
# login. Run after scripts/collect.sh.
#
# Usage: scripts/cf-analytics.sh <date-dir>
source "$(dirname "$0")/lib.sh"

date_dir=${1:?date dir under results/}
cd "$ROOT/cloudflare"
account=$(pnpm exec wrangler whoami 2>/dev/null | grep -o -E '[0-9a-f]{32}' | head -1)
[[ -n $account ]] || { echo "no Cloudflare account id from wrangler whoami; log in first" >&2; exit 1; }
dir="$ROOT/results/$date_dir/cloudflare"
files=$(ls "$dir"/create-*.json "$dir"/sql-*.json "$dir"/wake-*-*.json "$dir"/burst-*.json "$dir"/seqwrite-*.json 2>/dev/null | grep -v -E '/wake-w[0-9]+\.json$' || true)
[[ -n $files ]] || { echo "no result files under $dir" >&2; exit 1; }
# Separate calls keep each request inside the API's size budget.
for f in $files; do
	CF_ACCOUNT_ID=$account RESULTS_DIR=$dir node analytics.mjs "$f"
done
