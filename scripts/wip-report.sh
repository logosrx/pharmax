#!/bin/bash
# scripts/wip-report.sh
#
# Fast, dependency-free version of `pnpm check:wip` (see
# scripts/check-wip.ts for the full rationale), plus the shared-checkout
# notice described below. Pure git + awk, so it runs in environments
# where Node is not on PATH — notably the Cursor hook process, which is
# spawned by the GUI app and does not inherit a shell profile.
#
# Called from three places, all advisory by construction:
#   - .cursor/hooks.json on `sessionStart`, so a session opens knowing
#     what it inherited.
#   - .cursor/hooks.json on `stop`, i.e. the end of every agent turn.
#     That is the moment work actually accumulates.
#   - .husky/post-commit, which can only run AFTER you did the right
#     thing, so it cannot discourage committing.
#
# It never blocks and always exits 0. Emits `{}` on stdout to satisfy
# the Cursor hook's JSON expectation and puts the human-readable report
# on stderr.
#
# The thresholds below are duplicated from scripts/check-wip.ts because
# this is a separate implementation; scripts/check-wip.test.ts asserts
# the two agree, so a silent divergence fails CI rather than quietly
# making one of them wrong.

FILE_COUNT_THRESHOLD=20
AREA_COUNT_THRESHOLD=4

# Window within which a branch change is worth mentioning. Tonight's
# collision switched branches three times inside a single minute, so
# anything at this scale is generous.
BRANCH_CHANGE_WINDOW_SECONDS=300

emit_json_and_exit() {
  echo '{}'
  exit 0
}

# Not a git repo, or git unavailable: say nothing.
git rev-parse --git-dir >/dev/null 2>&1 || emit_json_and_exit

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)

# --- shared-checkout notice -------------------------------------------
#
# If this checkout changed branch since the last time the hook ran, and
# it happened recently, say so. A session that switched deliberately
# will recognise its own action and ignore the line; a session that did
# NOT switch has just learned that something else is driving its working
# directory — which is the failure this notice exists to surface.
#
# The state file lives in the per-worktree git dir (`git rev-parse
# --git-path` resolves to .git/worktrees/<name> inside a linked
# worktree), so each worktree tracks its own HEAD independently and
# worktrees never trip each other's notice.
state_file=$(git rev-parse --git-path pharmax-session-branch 2>/dev/null)
now=$(date +%s)

if [ -n "$state_file" ] && [ -f "$state_file" ]; then
  read -r prev_branch prev_at <"$state_file" 2>/dev/null || true
  if [ -n "$prev_branch" ] && [ "$prev_branch" != "$branch" ]; then
    age=$((now - ${prev_at:-0}))
    if [ "$age" -ge 0 ] && [ "$age" -le "$BRANCH_CHANGE_WINDOW_SECONDS" ]; then
      {
        echo "[wip] this checkout moved from \"$prev_branch\" to \"$branch\" ${age}s ago."
        echo "      If that was not you, another session is sharing this working"
        echo "      directory — a branch switch carries everyone's uncommitted work"
        echo "      with it. Give this session its own tree:"
        echo "        pnpm session:new <branch-name>"
      } >&2
    fi
  fi
fi

if [ -n "$state_file" ]; then
  printf '%s %s\n' "$branch" "$now" >"$state_file" 2>/dev/null || true
fi

# --- accumulation report ----------------------------------------------

status=$(git status --porcelain --untracked-files=all 2>/dev/null)

[ -z "$status" ] && emit_json_and_exit

file_count=$(printf '%s\n' "$status" | grep -c .)

# Strip the 3-char porcelain prefix and follow renames ("old -> new") to
# their destination, then map each path to the app/package that owns it.
# Paths containing spaces are quoted by porcelain; they still map to the
# right area because only leading segments matter here.
areas=$(printf '%s\n' "$status" |
  cut -c4- |
  sed 's/.* -> //' |
  awk '{
    n = split($0, a, "/")
    if ((a[1] == "apps" || a[1] == "packages") && n > 2) print a[1] "/" a[2]
    else if (n > 1) print a[1]
    else print "(root)"
  }' |
  sort -u)
area_count=$(printf '%s\n' "$areas" | grep -c .)
area_list=$(printf '%s\n' "$areas" | paste -sd, - | sed 's/,/, /g')

findings=""
add() { findings="${findings}  $1\n"; }

if [ "$area_count" -gt "$AREA_COUNT_THRESHOLD" ]; then
  add "fan-out: $file_count uncommitted file(s) across $area_count areas ($area_list)."
  add "         Too wide for one reviewable PR — commit the areas separately now,"
  add "         while you still remember which change belongs to which feature."
elif [ "$file_count" -gt "$FILE_COUNT_THRESHOLD" ]; then
  add "volume: $file_count uncommitted file(s) (threshold $FILE_COUNT_THRESHOLD)."
  add "        Commit what is already coherent; leave only the live edit dirty."
fi

case "$branch" in
  main | master)
    add "on-trunk: $file_count uncommitted file(s) on \"$branch\"."
    add "          git switch -c <feature-branch>   # the changes come with you"
    ;;
esac

untracked_source=$(printf '%s\n' "$status" |
  grep '^??' |
  cut -c4- |
  grep -cE '\.(ts|tsx|js|mjs|cjs|prisma|sh)$')

if [ "$untracked_source" -gt 0 ]; then
  add "untracked-source: $untracked_source new source file(s) are untracked."
  add "                  A later split loses these entirely — there is no committed"
  add "                  version to diff against, so nothing notices they vanished."
fi

if [ -n "$findings" ]; then
  {
    echo "[wip] working tree is accumulating:"
    printf "%b" "$findings"
    echo "  → pnpm check:wip   for detail"
  } >&2
fi

emit_json_and_exit
