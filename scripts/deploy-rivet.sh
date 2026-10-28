#!/usr/bin/env bash
# Installs and starts the public Rivet Engine release on the three storage VMs, provisions
# one partition per zone (each replicated on all three workers, each maintained by its own
# zone's worker), and starts the RivetKit benchmark app on the runner VM. Idempotent: rerun after a
# change to redeploy. `scripts/deploy-rivet.sh reset` starts over on a fresh object prefix.
#
# Secrets (storage key, admin token) go to the VMs as mode 600 files and are never printed.
source "$(dirname "$0")/lib.sh"

NODE_VERSION=24.10.0
NODE_SHA256=2642f4428869aca32443660fd71b3918e2be1277a899bdcaeb64c93b54b5af17
PNPM_VERSION=10.13.1

load_outputs
if [[ ${1:-} == reset ]]; then
	rm -f "$LOCAL/object-prefix"
fi
token=$(admin_token)
prefix=$(object_prefix)
storage_key=$(az storage account keys list -g "$RESOURCE_GROUP" -n "$STORAGE_ACCOUNT" --query '[0].value' -o tsv)
z1_private=${STORAGE_PRIVATE_IPS[0]}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

render_engine_config() {
	local private_ip=$1 peer_port=$2 metrics_port=$3
	jq -s '.[0] * .[1]' "$ROOT/rivet/engine/overrides.json" <(jq -n \
		--arg prefix "$prefix" --arg token "$token" --arg key "$storage_key" \
		--arg account "$STORAGE_ACCOUNT" --arg container "$STORAGE_CONTAINER" \
		--arg private "$private_ip" --arg z1 "$z1_private" \
		--argjson peer "$peer_port" --argjson metrics "$metrics_port" '{
		guard: { host: "0.0.0.0", port: 6420 },
		pegboard: { gateway_port: 6420 },
		api_peer: { host: "0.0.0.0", port: $peer, advertise_address: ($private + ":" + ($peer|tostring)) },
		metrics: { host: "0.0.0.0", port: $metrics },
		storage: { log_directory: ("/mnt/nvme/rivet/" + $prefix) },
		telemetry: { enabled: false },
		auth: { admin_token: $token },
		object_storage: { primary: { azure: { account: $account, container: $container, prefix: $prefix, access_key: $key } } },
		topology: { datacenter_label: 1, datacenters: { default: { datacenter_label: 1, is_leader: true,
			public_url: ("http://" + $z1 + ":6420"), peer_url: ("http://" + $z1 + ":6421") } } }
	}')
}

deploy_storage() {
	local index=$1 host=${STORAGE_PUBLIC_IPS[$1]} private=${STORAGE_PRIVATE_IPS[$1]} zone=${STORAGE_ZONES[$1]}
	local dir="$work/storage-$index"
	mkdir -p "$dir"
	render_engine_config "$private" 6421 6430 > "$dir/engine.json"
	# Operator commands run as a separate stateless process on other ports.
	render_engine_config "$private" 6521 6531 > "$dir/operator.json"
	chmod 600 "$dir"/*.json
	rssh "$host" 'sudo apt-get -qq update >/dev/null && sudo DEBIAN_FRONTEND=noninteractive apt-get -qq install -y jq curl rsync >/dev/null; mkdir -p /tmp/rivet-deploy'
	rscp "$ROOT"/rivet/engine/{prepare-nvme.sh,fetch-engine.sh,rivet-engine.sha256,rivet-engine.image-digest,rivet-engine.service} "$dir"/engine.json "$dir"/operator.json "$ADMIN_USER@$host:/tmp/rivet-deploy/"
	rssh "$host" "set -e
		cd /tmp/rivet-deploy
		sudo systemctl stop rivet-engine 2>/dev/null || true
		bash prepare-nvme.sh >/dev/null
		bash fetch-engine.sh /opt/rivet/bin/rivet-engine
		mkdir -p /mnt/nvme/rivet/$prefix
		install -m 600 engine.json /opt/rivet/engine.json
		install -m 600 operator.json /opt/rivet/operator.json
		sudo cp rivet-engine.service /etc/systemd/system/rivet-engine.service
		sudo systemctl daemon-reload
		sudo systemctl start rivet-engine
		rm -f engine.json operator.json"
	echo "storage zone $zone started ($host)"
}

# Storage workers first, in parallel.
pids=()
for i in "${!STORAGE_PUBLIC_IPS[@]}"; do
	deploy_storage "$i" &
	pids+=($!)
done
for pid in "${pids[@]}"; do wait "$pid"; done

# Worker identities come from each process's own log line.
worker_ids=()
for i in "${!STORAGE_PUBLIC_IPS[@]}"; do
	host=${STORAGE_PUBLIC_IPS[$i]}
	id=""
	for _ in $(seq 1 60); do
		id=$(rssh "$host" "grep -a 'selected storage worker identity' /var/log/rivet/engine.log | tail -n 1 | grep -o -E '[0-9a-f-]{36}' | head -1" || true)
		[[ -n $id ]] && break
		sleep 2
	done
	[[ -n $id ]] || { echo "no worker identity on $host" >&2; exit 1; }
	worker_ids+=("$id")
	echo "zone ${STORAGE_ZONES[$i]} worker $id"
done

# Partitions: one equal hash range per storage worker. Every worker is a replica of every
# partition, and partition i is maintained by the worker in zone i, so maintainers are spread
# evenly across the zones. Balancing is off (overrides.json), so this placement is the same on
# every deploy and runs are reproducible.
z1_host=${STORAGE_PUBLIC_IPS[0]}
operator="RUST_LOG=error /opt/rivet/bin/rivet-engine --config /opt/rivet/operator.json storage"
manifest=""
for _ in $(seq 1 60); do
	manifest=$(rssh "$z1_host" "$operator partition show 2>/dev/null" | grep -v '^ts=' || true)
	[[ -n $manifest ]] && break
	sleep 3
done
[[ -n $manifest ]] || { echo "coordinator manifest not available" >&2; exit 1; }
partitions='(.tablets // .partitions)'
count_workers=${#worker_ids[@]}
if [[ $(echo "$manifest" | jq -r "$partitions | length") == 0 ]]; then
	members="${worker_ids[*]}"
	for i in $(seq 0 $((count_workers - 1))); do
		start=$(python3 -c "print($i * 2**128 // $count_workers)")
		end_arg=""
		if (( i < count_workers - 1 )); then end_arg="--end $(python3 -c "print(($i + 1) * 2**128 // $count_workers)")"; fi
		rssh "$z1_host" "$operator partition create --start $start $end_arg --members $members" | grep -v '^ts=' > /dev/null
	done
	manifest=$(rssh "$z1_host" "$operator partition show" | grep -v '^ts=')
	# Grant partitions in key-range order, partition i to the worker in zone i.
	i=0
	for tid in $(echo "$manifest" | jq -r "$partitions | sort_by(.hashRange.start)[] | (.tabletId // .partitionId)"); do
		rssh "$z1_host" "$operator partition grant $tid ${worker_ids[$i]}" | grep -v '^ts=' > /dev/null
		i=$((i + 1))
	done
	manifest=$(rssh "$z1_host" "$operator partition show" | grep -v '^ts=')
fi
count=$(echo "$manifest" | jq -r "$partitions | length")
spread=$(echo "$manifest" | jq -r "[$partitions[] | .maintainer] | unique | length")
echo "partitions: $count, distinct maintainers: $spread"
[[ $count == "$count_workers" && $spread == "$count_workers" ]] || { echo "unexpected placement" >&2; echo "$manifest" | jq . >&2; exit 1; }
echo "$manifest" > "$LOCAL/placement.json"
printf '%s\n' "${STORAGE_PRIVATE_IPS[@]}" > "$LOCAL/storage-hosts"

# Runner: Node, pnpm, the app and the driver, then the systemd unit.
rssh "$RUNNER_IP" "set -e
	sudo apt-get -qq update >/dev/null && sudo DEBIAN_FRONTEND=noninteractive apt-get -qq install -y jq curl rsync xz-utils >/dev/null
	sudo mkdir -p /opt/rivet /var/log/rivet && sudo chown -R $ADMIN_USER:$ADMIN_USER /opt/rivet /var/log/rivet
	if [[ ! -x /opt/rivet/node/bin/node ]] || [[ \$(/opt/rivet/node/bin/node --version) != v$NODE_VERSION ]]; then
		curl -fsSL -o /tmp/node.tar.xz https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz
		echo '$NODE_SHA256  /tmp/node.tar.xz' | sha256sum -c - >/dev/null
		rm -rf /opt/rivet/node && mkdir -p /opt/rivet/node && tar -xJf /tmp/node.tar.xz -C /opt/rivet/node --strip-components=1
	fi
	export PATH=/opt/rivet/node/bin:\$PATH
	if ! command -v pnpm >/dev/null || [[ \$(pnpm --version) != $PNPM_VERSION ]]; then
		npm install -g --silent pnpm@$PNPM_VERSION
	fi
	mkdir -p /opt/rivet/app /opt/rivet/bench /opt/rivet/results"
rrsync --exclude node_modules "$ROOT/rivet/app/" "$ADMIN_USER@$RUNNER_IP:/opt/rivet/app/"
rrsync --exclude node_modules "$ROOT/rivet/bench/" "$ADMIN_USER@$RUNNER_IP:/opt/rivet/bench/"
rscp "$LOCAL/bench_key" "$LOCAL/storage-hosts" "$ROOT/rivet/engine/rivet-node.service" "$ADMIN_USER@$RUNNER_IP:/opt/rivet/"
cat > "$work/node.env" <<EOF
NODE_ENV=production
RIVET_LOG_LEVEL=info
RUST_LOG=info
RIVET_NODE_VERSION=1
RIVET_ENDPOINT=http://default:$token@$z1_private:6420
EOF
chmod 600 "$work/node.env"
rscp "$work/node.env" "$ADMIN_USER@$RUNNER_IP:/opt/rivet/node.env"
rssh "$RUNNER_IP" "set -e
	export PATH=/opt/rivet/node/bin:\$PATH
	chmod 600 /opt/rivet/bench_key /opt/rivet/node.env
	echo 'export PATH=/opt/rivet/node/bin:\$PATH' > /opt/rivet/bench.env && chmod 600 /opt/rivet/bench.env
	echo 'export RIVET_ENDPOINT=http://default:$token@$z1_private:6420' >> /opt/rivet/bench.env
	cd /opt/rivet/app && pnpm install --frozen-lockfile --silent
	cd /opt/rivet/bench && pnpm install --frozen-lockfile --silent
	sudo cp /opt/rivet/rivet-node.service /etc/systemd/system/rivet-node.service
	sudo systemctl daemon-reload
	sudo systemctl restart rivet-node"

# The node pool must exist before nodes connect.
for _ in $(seq 1 30); do
	if rssh "$RUNNER_IP" "curl -fsS -X PUT 'http://$z1_private:6420/pools/default?namespace=default' -H 'Authorization: Bearer $token' -H 'Content-Type: application/json' -d '{}' >/dev/null 2>&1"; then
		break
	fi
	sleep 3
done
echo "waiting for the node to serve a probe"
for _ in $(seq 1 60); do
	if out=$(rssh "$RUNNER_IP" "source /opt/rivet/bench.env && cd /opt/rivet/bench && node bench.mjs probe --n 10 --out /tmp/probe 2>/dev/null | sed -n '/^{/,\$p' | jq -c '.metrics.probe | {n, errors, p50: .totalMs.p50}'") && [[ $out == *'"errors":0'* ]]; then
		echo "probe: $out"
		break
	fi
	sleep 5
done
echo "deployed on object prefix $prefix"
