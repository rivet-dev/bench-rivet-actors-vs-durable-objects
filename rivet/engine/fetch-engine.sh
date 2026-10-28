#!/usr/bin/env bash
# Downloads the public Rivet Engine binary out of the released Docker image without Docker.
#
# Usage: fetch-engine.sh <output-path>
#
# The image is pinned by tag and by manifest digest, and the extracted binary is checked
# against the SHA256 recorded next to this script, so every run uses the same release.
set -euo pipefail

out=${1:?output path}
image=rivetdev/engine
tag=3.0.0-preview.2
here=$(cd "$(dirname "$0")" && pwd)
expected_binary_sha=$(cut -d' ' -f1 "$here/rivet-engine.sha256")
expected_image_digest=$(cat "$here/rivet-engine.image-digest")

if [[ -x $out ]] && [[ $(sha256sum "$out" | cut -d' ' -f1) == "$expected_binary_sha" ]]; then
	echo "engine binary already present: $out"
	exit 0
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

token=$(curl -fsS "https://auth.docker.io/token?service=registry.docker.io&scope=repository:$image:pull" | jq -r .token)
auth=(-H "Authorization: Bearer $token")
registry=https://registry-1.docker.io/v2/$image

# Resolve the multi-arch index to the linux/amd64 manifest and check it is the pinned digest.
index=$(curl -fsS "${auth[@]}" -H 'Accept: application/vnd.oci.image.index.v1+json' "$registry/manifests/$tag")
amd64=$(echo "$index" | jq -r '.manifests[] | select(.platform.os=="linux" and .platform.architecture=="amd64") | .digest')
if [[ $amd64 != "$expected_image_digest" ]]; then
	echo "image digest changed: $amd64 (expected $expected_image_digest)" >&2
	exit 1
fi
manifest=$(curl -fsS "${auth[@]}" -H 'Accept: application/vnd.oci.image.manifest.v1+json' "$registry/manifests/$amd64")

# The binary lives in the last layer that contains it; walk layers in order so later layers win.
found=""
for layer in $(echo "$manifest" | jq -r '.layers[].digest'); do
	curl -fsSL "${auth[@]}" "$registry/blobs/$layer" -o "$work/layer.tar.gz"
	if tar -tzf "$work/layer.tar.gz" 2>/dev/null | grep -q -x 'usr/bin/rivet-engine'; then
		tar -xzf "$work/layer.tar.gz" -C "$work" usr/bin/rivet-engine
		found=yes
	fi
done
if [[ -z $found ]]; then
	echo "usr/bin/rivet-engine not found in any layer" >&2
	exit 1
fi

actual=$(sha256sum "$work/usr/bin/rivet-engine" | cut -d' ' -f1)
if [[ $actual != "$expected_binary_sha" ]]; then
	echo "engine binary hash mismatch: $actual (expected $expected_binary_sha)" >&2
	exit 1
fi
mkdir -p "$(dirname "$out")"
install -m 0755 "$work/usr/bin/rivet-engine" "$out"
echo "installed $out ($actual)"
