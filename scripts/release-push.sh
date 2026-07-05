#!/usr/bin/env bash
set -euo pipefail

MESSAGE="${1:-}"

if [[ "$MESSAGE" == "" ]]; then
  echo "Usage: npm run release:push -- \"commit message\""
  exit 1
fi

npm version patch --no-git-tag-version
npm run check
npm run lint
npm test

git add -u
git commit -m "$MESSAGE"
git push

VERSION="$(node -p "require('./package.json').version")"
echo "Pushed v${VERSION}. GitHub Actions will create the release after CI passes."
