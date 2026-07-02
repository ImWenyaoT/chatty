#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT_DIR"

if ! docker ps --format '{{.Names}}' | grep -q '^rental-qdrant$'; then
  if docker ps -a --format '{{.Names}}' | grep -q '^rental-qdrant$'; then
    docker start rental-qdrant >/dev/null
  else
    docker run -d --name rental-qdrant -p 6333:6333 -p 6334:6334 -v qdrant_storage:/qdrant/storage qdrant/qdrant >/dev/null
  fi
fi

for _ in {1..20}; do
  if curl -fsS http://127.0.0.1:6333/collections >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

pnpm ingest
exec pnpm dev
