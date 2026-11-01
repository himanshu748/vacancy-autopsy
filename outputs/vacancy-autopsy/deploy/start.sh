#!/bin/sh
set -eu
umask 077
if [ "$(id -u)" = 0 ]; then
  # The path is fixed, never supplied by a request or an environment variable.
  install -d -m 700 -o node -g node /var/lib/vacancy-autopsy/priority
  exec runuser -u node -- sh "$0" "$@"
fi
/opt/model-env/bin/python deploy/prepare-model-state.py
exec "$@"
