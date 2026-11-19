#!/bin/sh
set -e

# Fly.io (and Docker) mount volumes owned by root. Give the storage folder to
# the "node" user, then run the app as that user instead of root.
mkdir -p "${STORAGE_DIR:-/data}"
chown -R node:node "${STORAGE_DIR:-/data}"

exec su-exec node "$@"
