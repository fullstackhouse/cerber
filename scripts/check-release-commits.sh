#!/bin/bash
# Checks that a PR releases the same version however it is merged (FSH practice `library-release`).
#
#   scripts/check-release-commits.sh <base-sha> <head-sha> "<pr title>"
#
# semantic-release reads every commit a merge commit or a rebase brings to `main`, but only the
# title plus pasted commit messages of a multi-commit squash. Three rules make those agree:
#   (a) every non-merge commit header is a conventional commit;
#   (b) a commit whose body has a breaking-change note carries `!` in its header, so a stray
#       "Breaking change: ..." line cannot cut a major unseen;
#   (c) the PR title is a conventional commit at the highest release level among the commits.
set -euo pipefail

base="$1" head="$2" title="$3"
header_re='^(feat|fix|perf|revert|refactor|docs|test|chore|ci|build|style)(\([^)]+\))?(!)?: .+'
# What conventional-changelog's parser treats as a breaking note: a body line starting
# "breaking change" / "breaking-change", in any case, after optional spaces, `*` or `|`.
note_re='^[[:space:]|*]*breaking[ -]change[: ]'
names=(none patch minor major)

level() { # header -> 0 none, 1 patch, 2 minor, 3 major
  # GitHub's revert button writes `Revert "<subject>"`; the conventionalcommits preset releases it
  # as a patch, so it is accepted as one.
  [[ "$1" =~ ^Revert\ \".+\"$ ]] && { echo 1; return; }
  [[ "$1" =~ $header_re ]] || { echo -1; return; }
  if [[ -n "${BASH_REMATCH[3]}" ]]; then echo 3; return; fi
  case "${BASH_REMATCH[1]}" in feat) echo 2 ;; fix|perf|revert) echo 1 ;; *) echo 0 ;; esac
}

errors=0 max=0
while IFS= read -r sha; do
  subject="$(git log -1 --format=%s "$sha")"
  body="$(git log -1 --format=%b "$sha")"
  l="$(level "$subject")"
  if [[ "$l" == -1 ]]; then
    echo "::error::${sha:0:7} \"$subject\" is not a conventional commit header — reword it (git rebase -i)"
    errors=$((errors + 1)); continue
  fi
  if [[ "$l" != 3 ]] && grep -qiE "$note_re" <<<"$body"; then
    echo "::error::${sha:0:7} \"$subject\" has a breaking-change line in its body but no \`!\` — that line cuts a major. Add \`!\` if it is one, otherwise reword the line"
    errors=$((errors + 1))
  fi
  (( l > max )) && max="$l"
done < <(git rev-list --no-merges "$base..$head")

t="$(level "$title")"
if [[ "$t" == -1 ]]; then
  echo "::error::PR title \"$title\" is not a conventional commit header"
  errors=$((errors + 1))
elif [[ "$t" != "$max" ]]; then
  echo "::error::PR title releases ${names[$t]} but its commits release ${names[$max]} — a squash and a merge would ship different versions. Make them agree"
  errors=$((errors + 1))
fi

(( errors == 0 )) || exit 1
echo "This PR releases: ${names[$max]}"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  echo "This PR releases: **${names[$max]}**" >> "$GITHUB_STEP_SUMMARY"
fi
