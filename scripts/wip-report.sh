#!/bin/bash
# scripts/wip-report.sh
#
# Fast, dependency-free version of `pnpm check:wip` (see
# scripts/check-wip.ts for the full rationale). Pure git + awk, so it
# runs in environments where Node is not on PATH — notably the Cursor
# hook process, which is spawned by the GUI app and does not inherit a
# shell profile.
#
# Called from two places, both of which are advisory by construction:
#   - .cursor/hooks.json on the `stop` event, i.e. the end of every
#     agent turn. That is the moment work actually accumulates.
#   - .husky/post-commit, which can only ever run AFTER you did the
#     right thing, so it cannot discourage committing.
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

emit_json_and_exit() {
  echo '{}'
  exit 0
}

# Not a git repo, or git unavailable: say nothing.
git rev-parse --git-dir >/dev/null 2>&1 || emit_json_and_exit

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
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
  grep -cE '\.(ts|tsx|js|mjs|cjs|prisma)$')

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
