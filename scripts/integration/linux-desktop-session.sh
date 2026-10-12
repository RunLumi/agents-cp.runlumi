#!/usr/bin/env bash
# Owned headless desktop session for the actual Electron gate on Linux.
#
# Usage: linux-desktop-session.sh <state-dir> <command> [args...]
#
# Starts a private D-Bus session bus, an Xvfb display and a gnome-keyring Secret Service whose
# data lives only under <state-dir>, unlocked with a synthetic password. The personal keyring,
# display and session bus are never used. Electron must still select the keystore explicitly
# (`--password-store=gnome-libsecret`); the product refuses `basic_text` and so does this gate.
set -euo pipefail
state=${1:?state directory required}
shift
for tool in dbus-run-session dbus-send xvfb-run gnome-keyring-daemon secret-tool; do
  command -v "$tool" >/dev/null || { echo "BLOCKED: $tool is required" >&2; exit 2; }
done
mkdir -p "$state/data"
# Unix socket paths are limited to ~108 bytes, so the runtime directory (keyring control socket)
# lives in a short, private temporary directory that this script removes, not under <state-dir>.
runtime=$(mktemp -d "${TMPDIR:-/tmp}/lumi-xdg-XXXXXX")
cleanup() {
  # The desktop document portal may leave a FUSE mount here; unmount before removing.
  fusermount -uz "${runtime:?}/doc" 2>/dev/null || true
  rm -rf "${runtime:?}" 2>/dev/null || true
}
trap cleanup EXIT
# Exported before the bus starts, so a D-Bus-activated keyring daemon inherits the owned paths.
export XDG_DATA_HOME="$state/data" XDG_RUNTIME_DIR="$runtime"
set +e
dbus-run-session -- xvfb-run -a -s "-screen 0 1440x900x24" bash -c '
  set -euo pipefail
  # One foreground daemon, unlocked from stdin, owned by this session (it exits with the bus).
  # A daemonized `--unlock` intermittently never claimed the bus name (retained run logs).
  printf "synthetic-e2e-keyring" |
    gnome-keyring-daemon --foreground --unlock --components=secrets >/dev/null 2>&1 &
  # The unlocked daemon must own the Secret Service name before Electron (or its desktop portal)
  # asks for it; otherwise D-Bus activates a second, locked daemon and secure storage times out.
  owned=""
  for _ in $(seq 100); do
    # Capture first: under pipefail, `dbus-send | grep -q` fails when grep closes the pipe early.
    reply=$(dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus \
      org.freedesktop.DBus.NameHasOwner string:org.freedesktop.secrets 2>/dev/null || true)
    if [[ $reply == *"boolean true"* ]]; then owned=1; break; fi
    sleep 0.1
  done
  probe="lumi-e2e-session-$$"
  if [ -z "$owned" ] ||
    ! printf "%s" "$probe" | secret-tool store --label="$probe" lumi-e2e "$probe" 2>/dev/null ||
    [ "$(secret-tool lookup lumi-e2e "$probe" 2>/dev/null)" != "$probe" ]; then
    echo "BLOCKED: owned Secret Service did not start unlocked" >&2
    exit 2
  fi
  secret-tool clear lumi-e2e "$probe" 2>/dev/null || true
  unset XDG_DATA_HOME
  exec "$@"
' bash "$@"
status=$?
cleanup
exit "$status"
