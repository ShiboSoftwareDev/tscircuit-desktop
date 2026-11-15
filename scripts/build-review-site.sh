#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--setup" ]]; then
  node scripts/setup.ts --no-install
  node_version=$(node -p "require('./.t3code/package.json').engines.node")
  pnpm_package=$(node -p "require('./.t3code/package.json').packageManager")
  tools_dir="$PWD/.cache/preview-tools"
  npm install --prefix "$tools_dir" --no-package-lock "node@$node_version" "${pnpm_package%%+*}"
  export PATH="$tools_dir/node_modules/.bin:$PATH"
  pnpm --dir .t3code install --filter '@t3tools/web...' --frozen-lockfile --ignore-scripts
fi

# Put the fixture beside the web app so it uses the same React and Vite dependencies.
fixture_dir=$(mktemp -d "$PWD/.t3code/apps/web/review-fixtures.XXXXXX")
trap 'rm -rf "$fixture_dir"' EXIT
cp scripts/fixtures/review-site/* "$fixture_dir/"
cd "$fixture_dir"
../node_modules/.bin/vp build --outDir ../../../../.cache/review-site --emptyOutDir
