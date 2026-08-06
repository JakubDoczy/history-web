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

# THE STAMP THIS DEPLOY PUT ON THE WORLD.
#
# Read out of dist/version.json rather than recomputed here, because a second
# way of working out the same fact is a second thing that can disagree with it —
# and the whole point of the stamp is to be the one identity the bundle, the
# settings footer and this log all share (vite.config.ts, src/lib/build.ts).
#
# It is printed twice, at the top and at the end, so it is in the scrollback
# whatever the session did afterwards. When a device reports something odd, the
# first question is whether the string in its Settings panel is this one.
read -r BUILD_ID BUILD_AT <<<"$(node -e '
  const v = JSON.parse(require("fs").readFileSync("dist/version.json", "utf8"))
  process.stdout.write(`${v.id} ${v.at}`)
')"
STAMP="${BUILD_ID} ${BUILD_AT}"
FOOTER="build ${BUILD_ID} · ${BUILD_AT%%T*}"   # exactly what buildLabel() prints
echo "Build stamp: ${STAMP}"

cd dist
touch .nojekyll
cp index.html 404.html        # SPA fallback for client-side routes
git init -q -b gh-pages
git config user.email "deploy@local"
git config user.name "deploy"
git add -A
git commit -qm "Deploy ${STAMP}"
git push -qf "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git" gh-pages
cd ..
rm -rf dist/.git

echo "Deployed → https://${REPO%%/*}.github.io/${REPO##*/}/"
echo "Build stamp: ${STAMP}"
echo
echo "A device is running this build when its Settings panel footer reads"
echo "  ${FOOTER}"
echo "Anything else is a cached tab: it will offer a reload within five minutes"
echo "of coming back to the foreground, or a hard refresh does it now."
