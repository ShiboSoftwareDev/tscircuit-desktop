#!/usr/bin/env bash
set -euo pipefail

node scripts/setup.ts --no-install
node_version=$(node -p "require('./.t3code/package.json').engines.node")
pnpm_package=$(node -p "require('./.t3code/package.json').packageManager")

tools_dir="$PWD/.cache/preview-tools"
npm install --prefix "$tools_dir" --no-package-lock "node@$node_version" "${pnpm_package%%+*}"
PATH="$tools_dir/node_modules/.bin:$PATH" node scripts/setup.ts
