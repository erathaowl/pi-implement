#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if [[ ! -f package.json ]]; then
  echo "Error: package.json was not found." >&2
  exit 1
fi

current_version="$(node -p "JSON.parse(require('fs').readFileSync('package.json', 'utf8')).version")"

read -r -p "Version (press Enter to increment the patch from $current_version): " requested_version || requested_version=""

if [[ -z "${requested_version//[[:space:]]/}" ]]; then
  npm version patch
else
  npm version "$requested_version"
fi

version="$(node -p "JSON.parse(require('fs').readFileSync('package.json', 'utf8')).version")"

echo "Building and validating version $version..."
npm test
npm run typecheck
npm publish

git push origin HEAD --follow-tags

echo "Published pi-implement@$version and pushed the release commit and tag."
