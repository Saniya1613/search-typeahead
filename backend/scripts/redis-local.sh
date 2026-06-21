#!/usr/bin/env bash
# redis-local.sh — run the 3 cache nodes as local redis-server processes.
#
# This is the no-Docker fallback for development on a machine without Docker.
# It starts the SAME 3 nodes (ports 6379/6380/6381) docker-compose.yml would,
# so the backend code and the consistent-hashing ring behave identically.
#
#   npm run redis:up     # start all 3
#   npm run redis:down   # stop all 3
#
# Each node is fully independent (separate process, separate port) — exactly
# what consistent hashing routes between.

set -euo pipefail

PORTS=(6379 6380 6381)
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/data/redis"
mkdir -p "$DIR"

up() {
  for p in "${PORTS[@]}"; do
    if redis-cli -p "$p" ping >/dev/null 2>&1; then
      echo "cache node on :$p already running"
    else
      # --save "" --appendonly no: no persistence; a cache is rebuildable.
      redis-server --port "$p" --save "" --appendonly no \
        --daemonize yes --pidfile "$DIR/redis-$p.pid" --logfile "$DIR/redis-$p.log"
      echo "started cache node on :$p"
    fi
  done
}

down() {
  for p in "${PORTS[@]}"; do
    if redis-cli -p "$p" ping >/dev/null 2>&1; then
      redis-cli -p "$p" shutdown nosave >/dev/null 2>&1 || true
      echo "stopped cache node on :$p"
    fi
  done
}

case "${1:-up}" in
  up) up ;;
  down) down ;;
  *) echo "usage: $0 {up|down}"; exit 1 ;;
esac
