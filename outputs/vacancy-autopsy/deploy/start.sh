#!/bin/sh
set -eu
umask 077
if [ "$(id -u)" = 0 ]; then
  # The path is fixed, never supplied by a request or an environment variable.
  # Initialize the mount root too: an existing root-only parent otherwise keeps
  # node from traversing to its own priority directory. Never recurse into state.
  if ! install -d -m 700 -o node -g node \
    /var/lib/vacancy-autopsy /var/lib/vacancy-autopsy/priority 2>/dev/null; then
    printf '%s\n' 'Model startup blocked [MOUNT_PERMISSIONS].' >&2
    exit 1
  fi
  exec runuser -u node -- sh "$0" "$@"
fi
/opt/model-env/bin/python deploy/prepare-model-state.py
exec "$@"
