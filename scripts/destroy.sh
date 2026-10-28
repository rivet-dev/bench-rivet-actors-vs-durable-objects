#!/usr/bin/env bash
# Destroys everything scripts/provision.sh created, then verifies nothing with the prefix is left.
source "$(dirname "$0")/lib.sh"

export ARM_SUBSCRIPTION_ID
ARM_SUBSCRIPTION_ID=$(az account show --query id -o tsv)

terraform -chdir="$TF_DIR" destroy -input=false -auto-approve
rm -f "$LOCAL/object-prefix" "$LOCAL/storage-hosts"

echo "remaining resources named ${PREFIX}* in $RESOURCE_GROUP:"
az resource list -g "$RESOURCE_GROUP" --query "[?starts_with(name, '${PREFIX}')].{name:name,type:type}" -o table
