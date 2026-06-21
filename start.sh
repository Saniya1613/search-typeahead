#!/usr/bin/env bash
# Container entrypoint: start the 3 Redis cache nodes, then the backend.
set -e

redis-server --port 6379 --save "" --appendonly no --daemonize yes --logfile /dev/null
redis-server --port 6380 --save "" --appendonly no --daemonize yes --logfile /dev/null
redis-server --port 6381 --save "" --appendonly no --daemonize yes --logfile /dev/null

cd backend
exec npm run start
