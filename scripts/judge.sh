#!/usr/bin/env bash
# One command for judges: checks Node, creates .env from .env.example if there
# is none, installs dependencies, seeds the demo business (Cedar Street
# Barbers) into ./data when no local database exists, adds the three other
# demo businesses (idempotent), and starts the app on
# http://localhost:3000. Local storage only; nothing is deployed.
set -euo pipefail
cd "$(dirname "$0")/.."

# Dependencies need Node ^20.19 or >=22.12.
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=12)||(a===20&&b>=19)?0:1)'; then
  echo "Node 22.12+ or 20.19+ is required (found $(node -v)). With nvm, in this directory: nvm install && nvm use" >&2
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
