#!/usr/bin/env bash
# Install the /ship skill into your user-level Claude Code config.
# Works in Git Bash on Windows, macOS and Linux. Re-run to update.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$here/skill"
claude_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
dest="$claude_dir/skills/ship"

command -v node >/dev/null 2>&1 || { echo "install: node is required on PATH" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "install: git is required on PATH" >&2; exit 1; }
[ -f "$src/SKILL.md" ] || { echo "install: $src/SKILL.md not found" >&2; exit 1; }

mkdir -p "$claude_dir/skills"
staging="$dest.installing"
rm -rf "$staging"
cp -R "$src" "$staging"

# Hooks run without a shell, so the skill needs an absolute path that node understands.
# On Git Bash, convert /c/Users/... to C:/Users/...
ship_home="$dest"
if command -v cygpath >/dev/null 2>&1; then ship_home="$(cygpath -m "$dest")"; fi

node -e '
  const fs = require("fs");
  const [file, home] = process.argv.slice(1);
  const text = fs.readFileSync(file, "utf8").split("__SHIP_HOME__").join(home);
  fs.writeFileSync(file, text);
' "$staging/SKILL.md" "$ship_home"

rm -rf "$dest"
mv "$staging" "$dest"

node "$dest/scripts/ship.mjs" help >/dev/null
echo "Installed /ship to $dest"
echo "Start Claude Code in a repo (auto mode recommended: claude --permission-mode auto) and run: /ship <task>"
