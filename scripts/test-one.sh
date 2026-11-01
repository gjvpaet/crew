#!/bin/sh
# `claude plugin test` runs every test under a folder; this runs only the named files, from a scratch copy of the mod.
set -e
here=$(cd "$(dirname "$0")/.." && pwd)
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
cp -R "$here/.claude-plugin" "$here/hooks" "$here/types" "$dir/"
[ -d "$here/skills" ] && cp -R "$here/skills" "$dir/"
mkdir "$dir/test"
for file in "$@"; do cp "$here/test/$file" "$dir/test/"; done
~/.bun/bin/bun x claude plugin test "$dir"
