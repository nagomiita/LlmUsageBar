#!/usr/bin/env bash
set -euo pipefail

if [[ ${1:-} == "" ]]; then
  echo "Usage: npm run release:local -- <version>"
  echo "Example: npm run release:local -- 0.1.1"
  exit 1
fi

VERSION="$1"
TAG="v${VERSION}"
VSIX="llm-usage-bar-${VERSION}.vsix"

if ! command -v gh >/dev/null 2>&1; then
  echo "Error: gh command is required"
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "Error: gh auth is required. Run: gh auth login"
  exit 1
fi

# Ensure the release tag does not already exist.
if gh release view "$TAG" >/dev/null 2>&1; then
  echo "Error: release ${TAG} already exists"
  exit 1
fi

npm version "$VERSION" --no-git-tag-version
npm ci
npm run check
npm run lint
npm test
npm run package:vsix

if [[ ! -f "$VSIX" ]]; then
  echo "Error: VSIX not found: $VSIX"
  exit 1
fi

git add package.json package-lock.json
git commit -m "Bump extension version to ${VERSION}"
git push

gh release create "$TAG" \
  --title "$TAG" \
  --notes "Local build release for LLM Usage Bar ${VERSION}" \
  "$VSIX"

echo "Done: ${TAG} published with ${VSIX}"
