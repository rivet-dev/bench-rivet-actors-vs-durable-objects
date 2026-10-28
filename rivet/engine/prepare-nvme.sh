#!/usr/bin/env bash
# Formats and mounts the local NVMe disk of an L-series VM at /mnt/nvme (ext4, noatime).
# Idempotent: a mounted /mnt/nvme is left alone. The device is the largest unmounted NVMe disk.
set -euo pipefail
if ! mountpoint -q /mnt/nvme; then
	device=$(lsblk -bdn -o NAME,SIZE,TYPE,MOUNTPOINTS | awk '$3=="disk" && $1 ~ /^nvme/ && $4=="" {print $2, $1}' | sort -n | tail -1 | awk '{print "/dev/"$2}')
	[[ -n $device ]] || { echo "no unmounted NVMe disk found" >&2; exit 1; }
	size=$(lsblk -bdn -o SIZE "$device")
	(( size > 1000000000000 )) || { echo "$device is only $size bytes; expected the local NVMe" >&2; exit 1; }
	sudo mkfs.ext4 -F -q "$device"
	sudo mkdir -p /mnt/nvme
	sudo mount -o noatime "$device" /mnt/nvme
fi
sudo mkdir -p /mnt/nvme/rivet /opt/rivet/bin /var/log/rivet
sudo chown -R rivet:rivet /mnt/nvme/rivet /opt/rivet /var/log/rivet
findmnt /mnt/nvme
