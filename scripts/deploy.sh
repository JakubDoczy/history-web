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

# PUSHED IS NOT PUBLISHED.
#
# Rounds 46 and 47 of this project pushed perfectly good builds to gh-pages,
# printed "Deployed →", and the user spent hours looking at a build two rounds
# old — GitHub's legacy Pages builder had errored ("Page build failed", no
# further detail) and then hung, and nothing here noticed. This script now
# refuses to say the word "deployed" until GitHub says "built" AND the live
# site serves this build's own version.json. If either check fails, it exits
# nonzero and says exactly what it saw — a loud failure is the cheap one.
SITE="https://${REPO%%/*}.github.io/${REPO##*/}"
echo "Pushed. Waiting for GitHub Pages to publish…"
for i in $(seq 1 60); do
  sleep 10
  STATUS=$(curl -s -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    "https://api.github.com/repos/${REPO}/pages/builds/latest" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);process.stdout.write(`${j.status} ${j.error?.message??""}`)})')
  case "${STATUS%% *}" in
    built)   echo "Pages build: built."; break ;;
    errored) echo "PAGES BUILD FAILED: ${STATUS#* }"; exit 1 ;;
    *)       [ "$i" = 60 ] && { echo "PAGES BUILD STILL '${STATUS%% *}' AFTER 10 MINUTES — NOT PUBLISHED."; exit 1; } ;;
  esac
done
LIVE=$(curl -s "${SITE}/version.json?ts=$(date +%s)" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).id??"unparseable")}catch{process.stdout.write("unparseable")}})')
if [ "${LIVE}" != "${BUILD_ID}" ]; then
  echo "LIVE SITE SERVES '${LIVE}', EXPECTED '${BUILD_ID}' — NOT PUBLISHED (CDN may lag; re-run to re-check)."
  exit 1
fi
echo "Live site verified serving ${BUILD_ID}."

echo "Deployed → ${SITE}/"
echo "Build stamp: ${STAMP}"
echo
echo "A device is running this build when its Settings panel footer reads"
echo "  ${FOOTER}"
echo "Anything else is a cached tab: it will offer a reload within five minutes"
echo "of coming back to the foreground, or a hard refresh does it now."
