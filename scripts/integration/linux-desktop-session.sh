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
for tool in dbus-run-session xvfb-run gnome-keyring-daemon; do
  command -v "$tool" >/dev/null || { echo "BLOCKED: $tool is required" >&2; exit 2; }
done
mkdir -p "$state/data" "$state/run"
chmod 700 "$state/run"
# Exported before the bus starts, so a D-Bus-activated keyring daemon inherits the owned paths.
export XDG_DATA_HOME="$state/data" XDG_RUNTIME_DIR="$state/run"
exec dbus-run-session -- xvfb-run -a -s "-screen 0 1440x900x24" bash -c '
  set -euo pipefail
  printf "synthetic-e2e-keyring" | gnome-keyring-daemon --unlock --components=secrets >/dev/null
  unset XDG_DATA_HOME
  exec "$@"
' bash "$@"
