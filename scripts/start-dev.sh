#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Kill any existing processes for server and vite on these ports
fuser -k 3100/tcp 2>/dev/null || true
fuser -k 5173/tcp 2>/dev/null || true

export PORT=3100
export ADMIN_TOKEN="admin1234567890123456"
export WG_DEV_SHIM="true"
export DATABASE_PATH="$DIR/data/sqlite.db"

cd "$DIR/packages/server"
nohup bun run src/index.ts > /tmp/wg-server.log 2>&1 &
SERVER_PID=$!
echo "Backend running on port $PORT (PID $SERVER_PID)"

cd "$DIR/packages/app"
nohup bun run dev > /tmp/wg-vite.log 2>&1 &
VITE_PID=$!
echo "Vite running on port 5173 (PID $VITE_PID)"
