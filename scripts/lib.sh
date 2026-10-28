# Shared helpers for the scripts. Sourced, not executed.
#
# Every script runs from the repository root. Deployment state that must not be committed
# (admin token, object prefix, host list) lives under .local/, which .gitignore excludes.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
LOCAL="$ROOT/.local"
TF_DIR="$ROOT/infra/azure"
mkdir -p "$LOCAL"

# Reads a variable from infra/azure/terraform.tfvars, or returns the default.
tf_var() {
	local name=$1 default=$2 value
	value=$(grep -E "^\s*$name\s*=" "$TF_DIR/terraform.tfvars" 2>/dev/null | sed -E 's/.*"([^"]+)".*/\1/' || true)
	echo "${value:-$default}"
}
RESOURCE_GROUP=$(tf_var resource_group rivet-vs-do-bench)
PREFIX=$(tf_var prefix rvdo)

SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$LOCAL/known_hosts" -o ConnectTimeout=15 -o ServerAliveInterval=15)

# Reads the Terraform outputs once into shell variables.
load_outputs() {
	local json
	json=$(terraform -chdir="$TF_DIR" output -json)
	ADMIN_USER=$(echo "$json" | jq -r .admin_username.value)
	STORAGE_ACCOUNT=$(echo "$json" | jq -r .storage_account.value)
	STORAGE_CONTAINER=$(echo "$json" | jq -r .storage_container.value)
	RUNNER_IP=$(echo "$json" | jq -r '.vms.value.runner.public_ip')
	RUNNER_PRIVATE_IP=$(echo "$json" | jq -r '.vms.value.runner.private_ip')
	# Storage workers in zone order; worker i maintains partition i.
	STORAGE_KEYS=$(echo "$json" | jq -r '.vms.value | keys[] | select(startswith("storage-"))' | sort)
	STORAGE_PUBLIC_IPS=()
	STORAGE_PRIVATE_IPS=()
	STORAGE_ZONES=()
	local key
	for key in $STORAGE_KEYS; do
		STORAGE_PUBLIC_IPS+=("$(echo "$json" | jq -r ".vms.value[\"$key\"].public_ip")")
		STORAGE_PRIVATE_IPS+=("$(echo "$json" | jq -r ".vms.value[\"$key\"].private_ip")")
		STORAGE_ZONES+=("$(echo "$json" | jq -r ".vms.value[\"$key\"].zone")")
	done
	echo "$json" | jq -r .bench_private_key.value > "$LOCAL/bench_key"
	chmod 600 "$LOCAL/bench_key"
}

rssh() {
	local host=$1
	shift
	ssh "${SSH_OPTS[@]}" "$ADMIN_USER@$host" "$@"
}

rscp() {
	scp -q "${SSH_OPTS[@]}" "$@"
}

rrsync() {
	rsync -az -e "ssh ${SSH_OPTS[*]}" "$@"
}

# Waits until a host answers SSH.
wait_ssh() {
	local host=$1 i
	for i in $(seq 1 60); do
		if rssh "$host" true 2>/dev/null; then
			return 0
		fi
		sleep 5
	done
	echo "ssh to $host did not come up" >&2
	return 1
}

admin_token() {
	if [[ ! -s $LOCAL/admin-token ]]; then
		openssl rand -hex 24 > "$LOCAL/admin-token"
		chmod 600 "$LOCAL/admin-token"
	fi
	cat "$LOCAL/admin-token"
}

# A fresh object prefix per deployment gives every run an empty cluster.
object_prefix() {
	if [[ ! -s $LOCAL/object-prefix ]]; then
		echo "bench-$(date -u +%Y%m%d-%H%M%S)" > "$LOCAL/object-prefix"
	fi
	cat "$LOCAL/object-prefix"
}
