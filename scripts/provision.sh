#!/usr/bin/env bash
# Creates the Azure benchmark cluster with Terraform. Idempotent.
#
# Requires: terraform, az (logged in), jq. The subscription comes from `az account show`.
# Put your own egress address in infra/azure/terraform.tfvars, for example:
#   ssh_source_cidrs = ["203.0.113.4/32"]
source "$(dirname "$0")/lib.sh"

export ARM_SUBSCRIPTION_ID
ARM_SUBSCRIPTION_ID=$(az account show --query id -o tsv)
terraform -chdir="$TF_DIR" init -input=false
terraform -chdir="$TF_DIR" apply -input=false -auto-approve
load_outputs
echo "runner: $RUNNER_IP"
for i in "${!STORAGE_PUBLIC_IPS[@]}"; do
	echo "storage zone ${STORAGE_ZONES[$i]}: ${STORAGE_PUBLIC_IPS[$i]} (${STORAGE_PRIVATE_IPS[$i]})"
done
for host in "$RUNNER_IP" "${STORAGE_PUBLIC_IPS[@]}"; do
	wait_ssh "$host"
done
echo "all VMs answer SSH"
