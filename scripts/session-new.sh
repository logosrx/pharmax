#!/bin/bash
# scripts/session-new.sh — start an agent session in its own worktree.
#
#   pnpm session:new feat/provider-portal
#
# Why this exists. On 2026-08-02 three agent sessions were found running
# against this repository at once, two of them sharing the single
# checkout at ~/Desktop/Pharmax. Within about a minute that checkout was
# switched between `main`, `docs/risk-register-sast-dismissals` and
# `fix/codeql-crypto-sanitization` by different sessions, while each held
# uncommitted edits.
#
# Sharing one working directory produces two failures that no amount of
# commit discipline can fix:
#
#   1. Nobody commits. When several sessions edit one tree, no session
#      can tell which changes are its own, and committing would sweep up
#      someone else's half-finished work. So everyone waits, and the tree
#      grows — this is the mechanism behind the 211-file pile, not
#      laziness. It also tangles single files: that day a one-line
#      `check:wip` addition and an unrelated vitest bump ended up
#      interleaved in the same package.json and had to be separated by
#      hand.
#   2. A branch switch silently relocates everyone. `git switch` carries
#      every uncommitted change in the tree with it, including changes
#      belonging to other sessions, which is how work lands on a branch
#      nobody meant to put it on.
#
# Worktrees fix both: each session gets its own directory, its own HEAD
# and its own index, while sharing one object store and one set of
# branches. Committing is safe because the tree contains only your work.
#
# Layout: a worktree per session, as a sibling of the primary checkout.
#
#   ~/Desktop/Pharmax             <- primary, stays on main
#   ~/Desktop/Pharmax-<slug>      <- one per session
#
# Usage:
#   pnpm session:new <branch-name> [--no-install] [--from <ref>]
#
#   --no-install   skip `pnpm install` (the worktree will not build until
#                  you run it yourself — node_modules is per-worktree)
#   --from <ref>   base the branch on <ref> instead of origin/main

set -e

branch=""
base="origin/main"
run_install=1

while [ $# -gt 0 ]; do
  case "$1" in
    --no-install)
      run_install=0
      shift
      ;;
    --from)
      base="$2"
      shift 2
      ;;
    -*)
      echo "session:new: unknown option $1" >&2
      exit 2
      ;;
    *)
      if [ -n "$branch" ]; then
        echo "session:new: unexpected argument $1" >&2
        exit 2
      fi
      branch="$1"
      shift
      ;;
  esac
done

if [ -z "$branch" ]; then
  cat >&2 <<'EOF'
usage: pnpm session:new <branch-name> [--no-install] [--from <ref>]

  pnpm session:new feat/provider-portal
  pnpm session:new fix/label-reprint --no-install

Creates a sibling worktree so this session's edits cannot collide with
another session's. Run it once per agent session.
EOF
  exit 2
fi

# `git worktree add` accepts almost anything and fails late; check early
# so the error names the actual problem.
case "$branch" in
  -* | */ | *//* | *' '*)
    echo "session:new: \"$branch\" is not a usable branch name" >&2
    exit 2
    ;;
esac

if git show-ref --verify --quiet "refs/heads/$branch"; then
  echo "session:new: branch \"$branch\" already exists." >&2
  echo "  Existing worktrees:" >&2
  git worktree list | sed 's/^/    /' >&2
  exit 1
fi

# Slug the branch for the directory: feat/provider-portal -> provider-portal.
slug=$(printf '%s' "$branch" | sed 's#.*/##; s#[^A-Za-z0-9._-]#-#g')

# Derive from the COMMON git dir, not this worktree's toplevel, so that
# running the script from inside a session worktree still produces
# `Pharmax-<slug>` as a sibling rather than `Pharmax-session-<slug>`
# nested off whichever worktree happened to invoke it. Every session
# worktree is a peer; none of them is a parent.
primary=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
dir="$(dirname "$primary")/$(basename "$primary")-$slug"

if [ -e "$dir" ]; then
  echo "session:new: $dir already exists — pick another name or remove it." >&2
  exit 1
fi

# Fail BEFORE touching any state if the sibling directory cannot be
# created. The agent sandbox allows writes only inside the workspace,
# and $dir is a sibling of the primary checkout by design — so a
# sandboxed run used to get partway: `git worktree add -b` writes the
# branch ref (inside the repo, allowed) before creating the directory
# (outside, denied), leaving a half-made branch and no worktree.
parent=$(dirname "$dir")
probe="$parent/.session-new-probe-$$"
if ! mkdir "$probe" 2>/dev/null; then
  cat >&2 <<EOF
session:new: cannot create directories in $parent.

Worktrees are siblings of the primary checkout, so this script needs
write access OUTSIDE the repository. If this is a sandboxed agent
session, re-run the command with sandboxing disabled (in Cursor:
required_permissions ["all"]). Nothing has been created or changed.
EOF
  exit 1
fi
rmdir "$probe"

echo "[session:new] fetching $base"
git fetch origin --quiet || echo "[session:new] fetch failed; using the local $base" >&2

echo "[session:new] creating worktree $dir on $branch (from $base)"
# Belt and braces for failure modes the probe cannot see (disk full,
# a race on $dir): if worktree creation fails, remove the branch ref
# it may already have written — we verified above that $branch did not
# exist, so deleting it cannot destroy anyone's work.
if ! git worktree add -b "$branch" "$dir" "$base"; then
  git branch -D "$branch" >/dev/null 2>&1 || true
  git worktree prune >/dev/null 2>&1 || true
  echo "session:new: worktree creation failed; branch \"$branch\" was rolled back." >&2
  exit 1
fi

# Symlink rather than copy: secrets should exist once on disk, and a
# rotated value should reach every worktree at the same moment.
for env_file in .env .env.local; do
  if [ -f "$primary/$env_file" ]; then
    ln -s "$primary/$env_file" "$dir/$env_file"
    echo "[session:new] linked $env_file -> $primary/$env_file"
  fi
done

if [ "$run_install" -eq 1 ]; then
  echo "[session:new] pnpm install (node_modules is per-worktree)"
  (cd "$dir" && pnpm install --frozen-lockfile)
else
  echo "[session:new] skipped install — run 'pnpm install' in $dir before building"
fi

cat <<EOF

[session:new] ready.

  cd $dir

Work and commit there. When the branch has landed:

  git worktree remove $dir
  git branch -d $branch

EOF
