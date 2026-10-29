#!/usr/bin/env bash
# One command for judges: checks Node, creates .env from .env.example if there
# is none, installs dependencies, seeds the demo business (Cedar Street
# Barbers) into ./data when no local database exists, adds the three other
# demo businesses (idempotent), and starts the app on
# http://localhost:3000. Local storage only; nothing is deployed.
set -euo pipefail
cd "$(dirname "$0")/.."

major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 20 ]; then
  echo "Node 20 or newer is required (found $(node -v)). With nvm: nvm install 20 && nvm use 20" >&2
  exit 1
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example. Live model calls stay off until you set MODEL_API_KEY, MODEL_CREDIT_BALANCE_USD and LIVE_CREDITS_VERIFIED=true (README, Spend safety)."
fi

if [ ! -d node_modules ]; then
  npm ci --no-audit --no-fund
fi

STORAGE_BACKEND=local npx tsx scripts/demo-reset.ts --if-missing
STORAGE_BACKEND=local npx tsx scripts/seed-demo-businesses.ts
echo "Open http://localhost:3000/owner (customer panel, approvals, content) and http://localhost:3000/onboard (brain onboarding)."
STORAGE_BACKEND=local exec npx next dev --port 3000
