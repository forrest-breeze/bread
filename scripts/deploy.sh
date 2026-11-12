#!/usr/bin/env bash
set -euo pipefail

# Deploy apps/web/app to Vercel with the Vercel CLI.
#
#   npm run deploy:preview   # preview deployment (protected *.vercel.app URL)
#   npm run deploy:prod      # production
#
# One-time setup, from the repo root:
#   1. npx vercel link            -> pick the Breeze Vercel team, create/choose the project
#   2. In the project's Settings -> General, set Root Directory to `apps/web/app`
#      (vercel.json in that folder supplies the install/build commands).
#   3. Add the environment variables listed in apps/web/app/README.md
#      ("Breeze internal setup") under Settings -> Environment Variables.
#   4. Keep Deployment Protection (Vercel Authentication) on.

MODE=${1:-}
if [ "$MODE" != "preview" ] && [ "$MODE" != "prod" ]; then
  echo "Usage: npm run deploy:<preview|prod>"
  exit 1
fi

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

if [ ! -f .vercel/project.json ]; then
  echo "This checkout is not linked to a Vercel project. Run: npx vercel link"
  exit 1
fi

if [ "$MODE" = "prod" ]; then
  npx --yes vercel deploy --prod
else
  npx --yes vercel deploy
fi
