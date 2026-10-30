#!/usr/bin/env bash
# A supported Linux host for the agent runtime checks (#480, #358 AC-3) on a workstation whose own kernel does not
# qualify (kernel.yama.ptrace_scope 0, Docker Desktop): a KVM guest running the official Ubuntu 24.04 cloud image
# (Yama ptrace_scope 1 by default) with Ubuntu's Docker packages. QEMU itself runs in a container with /dev/kvm; the
# host gets no package, sysctl, service or firewall change. The guest's SSH is published on 127.0.0.1 only.
#
#   scripts/agent-runtime/supported_guest.sh <state directory> [command run in the guest's checkout ...]
#
# The state directory keeps the verified image, the overlay disk, the SSH key and the logs (several GB: do not put
# it on a tmpfs). This commit is sent as a git bundle and checked out at the same SHA in the guest; the command (by
# default `scripts/check_agent_runtime.sh`) runs there and its output is copied to <state>/guest-<UTC time>.log.
# FLUX_GUEST_SSH_PORT (default 34022), FLUX_GUEST_CPUS (8), FLUX_GUEST_MEMORY (16G), FLUX_GUEST_DISK (80G).
# FLUX_GUEST_BINFMT=arm64 registers the release workflow's pinned QEMU emulator in the GUEST kernel first (for
# FLUX_DRYRUN_PLATFORMS in scripts/release/dry_run.sh). FLUX_GUEST_KEEP=1 leaves the guest running afterwards (ssh -p <port> -i <state>/id_ed25519 flux@127.0.0.1).
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
[ $# -ge 1 ] || { echo "usage: $0 <state directory> [command ...]" >&2; exit 2; }
state=$(mkdir -p "$1" && cd "$1" && pwd)
shift
[ $# -gt 0 ] || set -- scripts/check_agent_runtime.sh
port=${FLUX_GUEST_SSH_PORT:-34022}
cpus=${FLUX_GUEST_CPUS:-8}
memory=${FLUX_GUEST_MEMORY:-16G}
disk=${FLUX_GUEST_DISK:-80G}
name="flux-guest-$(basename "$state")"
release=${FLUX_GUEST_RELEASE:-current}
base_url="https://cloud-images.ubuntu.com/noble/$release"
image=noble-server-cloudimg-amd64.img
# Ubuntu's cloud image signing key (UEC), as published in Ubuntu's checksum verification guide.
uec_fpr=D2EB44626FDDC30B513D5BB71A5D6C4C7DB87C81
tools_image=alpine:3.21
log() { printf '\n== %s\n' "$*"; }
fail() { echo "supported_guest: $*" >&2; exit 1; }
[ -r /dev/kvm ] && [ -w /dev/kvm ] || fail "/dev/kvm is not usable by this user"
cleanup() {
  status=$?
  if [ "${FLUX_GUEST_KEEP:-0}" != 1 ]; then docker rm -f "$name" >/dev/null 2>&1 || true; fi
  exit "$status"
}
trap cleanup EXIT

log "Official Ubuntu 24.04 cloud image ($base_url), signed checksums"
mkdir -p "$state/image"
( cd "$state/image"
  curl -fsSLO "$base_url/SHA256SUMS" && curl -fsSLO "$base_url/SHA256SUMS.gpg"
  [ -f "$image" ] && grep -q " \*\?$image\$" SHA256SUMS && sha256sum --ignore-missing -c SHA256SUMS >/dev/null 2>&1 ||
    curl -fsSL -o "$image" "$base_url/$image" )
docker run --rm -v "$state/image:/i:ro" "$tools_image" sh -euc "
  apk add -q gnupg >/dev/null
  gpg -q --keyserver hkps://keyserver.ubuntu.com --recv-keys $uec_fpr
  gpg -q --verify /i/SHA256SUMS.gpg /i/SHA256SUMS 2>&1 | grep -E 'Good signature|using' || true
  gpg --status-fd 1 --verify /i/SHA256SUMS.gpg /i/SHA256SUMS 2>/dev/null | grep -q 'VALIDSIG $uec_fpr'
  cd /i && grep ' \*\?$image\$' SHA256SUMS | sha256sum -c -" || fail "the cloud image or its checksums did not verify"
grep " \*\?$image\$" "$state/image/SHA256SUMS"

log "Seed (cloud-init NoCloud): user flux with a fresh key, Ubuntu's docker.io, docker-compose-v2, docker-buildx"
[ -f "$state/id_ed25519" ] || ssh-keygen -q -t ed25519 -N '' -C flux-guest -f "$state/id_ed25519"
mkdir -p "$state/seed"
cat > "$state/seed/user-data" <<EOF
#cloud-config
hostname: flux-guest
users:
  - name: flux
    groups: [docker]
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    ssh_authorized_keys: ["$(cat "$state/id_ed25519.pub")"]
package_update: true
packages: [docker.io, docker-compose-v2, docker-buildx, git, python3, curl, iproute2]
runcmd:
  - [systemctl, enable, --now, docker]
  - [sh, -c, 'touch /var/lib/cloud/flux-ready']
EOF
printf 'instance-id: %s\nlocal-hostname: flux-guest\n' "$name" > "$state/seed/meta-data"
docker run --rm -v "$state/seed:/s" "$tools_image" sh -euc \
  'apk add -q xorriso >/dev/null; xorriso -as mkisofs -quiet -o /s/seed.iso -V cidata -J -r /s/user-data /s/meta-data'

log "Disk and guest ($cpus vCPU, $memory, $disk overlay on the read-only image; QEMU in a container with /dev/kvm)"
docker rm -f "$name" >/dev/null 2>&1 || true
rm -f "$state/disk.qcow2"
# QEMU's user-mode forward answers connections from the container's own loopback only (a connection through the
# published port reached it and got no SSH banner), so socat relays the published port 2223 to it.
docker run -d --name "$name" --device /dev/kvm -p "127.0.0.1:$port:2223" -v "$state:/g" "$tools_image" sh -euc "
  apk add -q qemu-system-x86_64 qemu-img socat >/dev/null
  qemu-img create -q -f qcow2 -F qcow2 -b /g/image/$image /g/disk.qcow2 $disk
  socat TCP-LISTEN:2223,fork,reuseaddr TCP:127.0.0.1:2222 &
  exec qemu-system-x86_64 -machine q35,accel=kvm -cpu host -smp $cpus -m $memory -nographic \
    -drive file=/g/disk.qcow2,if=virtio -drive file=/g/seed/seed.iso,if=virtio,media=cdrom \
    -netdev user,id=n0,hostfwd=tcp:127.0.0.1:2222-:22 -device virtio-net-pci,netdev=n0 -serial file:/g/serial.log -monitor none" >/dev/null
ssh_guest() { ssh -q -p "$port" -i "$state/id_ed25519" -o StrictHostKeyChecking=no -o UserKnownHostsFile="$state/known_hosts" \
  -o ConnectTimeout=5 -o ServerAliveInterval=30 flux@127.0.0.1 "$@"; }
for _ in $(seq 1 120); do ssh_guest test -f /var/lib/cloud/flux-ready 2>/dev/null && break; sleep 5; done
ssh_guest test -f /var/lib/cloud/flux-ready || { tail -n 40 "$state/serial.log" >&2; fail "the guest did not finish cloud-init"; }

log "Guest facts"
ssh_guest 'set -e; . /etc/os-release; echo "$PRETTY_NAME, kernel $(uname -r) $(uname -m)"
  echo "LSMs: $(cat /sys/kernel/security/lsm)"; echo "kernel.yama.ptrace_scope = $(cat /proc/sys/kernel/yama/ptrace_scope)"
  sudo -n docker version --format "Docker {{.Server.Version}} (API {{.Server.APIVersion}}) {{.Server.Os}}/{{.Server.Arch}}"
  docker compose version; docker buildx version'

sha=$(git -C "$root" rev-parse HEAD)
log "Source $sha as a git bundle"
git -C "$root" bundle create -q "$state/source.bundle" HEAD
scp -q -P "$port" -i "$state/id_ed25519" -o StrictHostKeyChecking=no -o UserKnownHostsFile="$state/known_hosts" \
  "$state/source.bundle" flux@127.0.0.1:source.bundle
ssh_guest "set -e; rm -rf flux; git clone -q source.bundle flux; cd flux; git -c advice.detachedHead=false checkout -q --detach $sha; git rev-parse HEAD"

if [ -n "${FLUX_GUEST_BINFMT:-}" ]; then
  log "QEMU binfmt for ${FLUX_GUEST_BINFMT} in the guest (the workflow's pinned tonistiigi/binfmt)"
  ssh_guest "sudo -n docker run --privileged --rm docker.io/tonistiigi/binfmt:qemu-v10.2.3@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0 --install ${FLUX_GUEST_BINFMT} >/dev/null && ls /proc/sys/fs/binfmt_misc/ | grep qemu && sudo -n docker info --format 'image store: {{.DriverStatus}}'"
fi
stamp=$(date -u +%Y%m%dT%H%M%SZ)
log "In the guest: $* (log: $state/guest-$stamp.log)"
quoted=$(printf '%q ' "$@")
set +e
ssh_guest "cd flux && sg docker -c $(printf '%q' "$quoted")" 2>&1 | tee "$state/guest-$stamp.log"
status=${PIPESTATUS[0]}
set -e
echo "guest command exit $status; kernel.yama.ptrace_scope afterwards: $(ssh_guest cat /proc/sys/kernel/yama/ptrace_scope)"
exit "$status"
