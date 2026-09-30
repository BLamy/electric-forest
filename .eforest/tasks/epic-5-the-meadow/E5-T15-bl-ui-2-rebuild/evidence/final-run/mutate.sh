#!/usr/bin/env bash
# E5-T15 contract sensitivity: each single mutation applied to a fresh scratch copy of the
# candidate tree must make `node tools/verify/e5_t15_ui_contract.mjs <copy>` exit non-zero.
set -uo pipefail
REPO=/Users/blamy/Documents/Codex/electric-forest
W=$REPO/.eforest/tasks/epic-5-the-meadow/E5-T15-bl-ui-2-rebuild/work
UP=$W/upstream/blocks/github-clone/registry/blocks/github-clone
SCRATCH=$W/mut
CONTRACT=$REPO/tools/verify/e5_t15_ui_contract.mjs

fresh() {
  rm -rf "$SCRATCH"
  mkdir -p "$SCRATCH/apps/web" "$SCRATCH/.eforest/tasks/epic-5-the-meadow/E5-T15-bl-ui-2-rebuild"
  rsync -a --exclude node_modules --exclude dist "$REPO/apps/web/" "$SCRATCH/apps/web/"
  cp -R "$REPO/.eforest/tasks/epic-5-the-meadow/E5-T15-bl-ui-2-rebuild/evidence" \
    "$SCRATCH/.eforest/tasks/epic-5-the-meadow/E5-T15-bl-ui-2-rebuild/"
  for f in package.json pnpm-lock.yaml .prettierignore .prettierrc eslint.config.mjs tsconfig.check.json tsconfig.base.json; do
    [ -e "$REPO/$f" ] && cp "$REPO/$f" "$SCRATCH/$f"
  done
}

run() {
  local name=$1
  local out
  out=$(node "$CONTRACT" "$SCRATCH" 2>&1)
  local code=$?
  echo "MUTATION $name exit=$code"
  echo "$out" | grep -E "CONTRACT_FAIL|CONTRACT_OK|CONTRACT_FAILED" | head -4 | sed 's/^/    /'
}

S=$SCRATCH/apps/web/src

fresh; run "0-unmutated-copy"

fresh; mkdir -p "$S/vendor/chatkit" && echo 'export {};' > "$S/vendor/chatkit/index.ts"
run "1-readd-vendor-chatkit"

fresh; cp "$UP/data.ts" "$S/blocks/github/data.ts"
perl -0pi -e 's/^(import .*\n)/$1import { PULLS } from ".\/data";\nvoid PULLS;\n/m' "$S/blocks/github/pulls-tab.tsx"
run "2-block-view-imports-mock-data"

fresh; perl -0pi -e 's/<Markdown\b/<MarkdownView/; s/^/import { MarkdownView } from "\@brett_lamy\/ui";\n/' "$S/wiki/WikiPage.tsx"
run "3a-wiki-MarkdownView"
fresh; perl -0pi -e 's/<Markdown source=\{message.body\}/<MessageMarkdown markdown={message.body}/; s/^/import { MessageMarkdown } from "\@brett_lamy\/ui";\n/' "$S/blocks/chat/channel-message.tsx"
run "3b-chat-MessageMarkdown"
fresh; perl -0pi -e 's/<Markdown\b/<FbMd/; s/^/import { FbMd } from "\@brett_lamy\/ui";\n/' "$S/issues/IssueDetail.tsx"
run "3c-issue-FbMd"
fresh; perl -0pi -e 's/<Markdown source=\{payload.body\}/<GitbookStreamdown markdown={payload.body}/; s/^/import { GitbookStreamdown } from "\@brett_lamy\/docstream\/gitbook";\n/' "$S/blocks/github/pull-request.tsx"
run "3d-pr-comment-GitbookStreamdown"

fresh
# Restore the upstream block FileTree into parts.tsx and render it instead of Pierre's.
awk '/^export function FileTree\(/,/^}$/' "$UP/parts.tsx" >> "$S/blocks/github/parts.tsx"
perl -0pi -e 's/import \{ FileTree, useFileTree \} from "\@pierre\/trees\/react";/import { useFileTree } from "\@pierre\/trees\/react";\nimport { FileTree } from "..\/..\/blocks\/github\/parts.js";/' "$S/components/trees/RepositoryTree.tsx"
run "4a-tree-block-FileTree"
fresh
awk '/^export function DiffView\(/,/^}$/' "$UP/parts.tsx" >> "$S/blocks/github/parts.tsx"
perl -0pi -e 's/<MultiFileDiff key=\{contentKey\} \{\.\.\.sides\} options=\{options\} \/>/<DiffView path="" patch="" add={0} del={0} \/>/' "$S/blocks/github/pull-request.tsx"
run "4b-diff-block-DiffView"

fresh; perl -pi -e 's/"\@brett_lamy\/ui": "2\.0\.0"/"\@brett_lamy\/ui": "^2.0.0"/' "$S/../package.json"
run "5a-unpin-caret"
fresh; perl -pi -e 's/"\@brett_lamy\/ui": "2\.0\.0"/"\@brett_lamy\/ui": "2.1.0"/' "$S/../package.json"
run "5b-pin-2.1.0"
fresh; perl -0pi -e "s/('\@brett_lamy\/ui':\n\s+specifier: 2\.0\.0\n\s+version: )2\.0\.0/\${1}2.1.0/" "$SCRATCH/pnpm-lock.yaml"
run "5c-lock-resolves-other"

rm -rf "$SCRATCH"
