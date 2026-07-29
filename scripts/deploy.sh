#!/usr/bin/env bash
# Build, verify and publish to GitHub Pages.
#
#   GITHUB_TOKEN=ghp_xxx ./scripts/deploy.sh
#
# The token is read from the environment and never written to disk. The gh-pages
# branch holds only build output; source lives on main.
set -euo pipefail

: "${GITHUB_TOKEN:?Set GITHUB_TOKEN (classic token with 'repo' scope)}"
REPO="${REPO:-JakubDoczy/history-web}"

npm test                      # deploys are gated on green tests, deliberately
npm run build

cd dist
touch .nojekyll
cp index.html 404.html        # SPA fallback for client-side routes
git init -q -b gh-pages
git config user.email "deploy@local"
git config user.name "deploy"
git add -A
git commit -qm "Deploy $(date -u +%F.%H%M)"
git push -qf "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git" gh-pages
cd ..
rm -rf dist/.git

echo "Deployed → https://${REPO%%/*}.github.io/${REPO##*/}/"
