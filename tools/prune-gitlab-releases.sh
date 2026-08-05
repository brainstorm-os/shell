#!/usr/bin/env bash
# Delete the artefacts of old releases from GitLab, keeping the N most recent.
#
# Why this exists: each release publishes ~1.7 GB of installers into the generic
# package registry, and the namespace has a hard storage cap (4.88 GiB on the
# free tier). Without pruning, the third publish fails on quota. We do not need
# every historical build — the site carries the release notes, and only the
# newest release feeds auto-update via the permalink.
#
# What it deletes, per pruned release:
#   * the generic package version (this is what actually frees the storage)
#   * the release object, so nothing advertises downloads that no longer exist
# The git tag is left alone — that is the durable record, and it costs nothing.
#
# DRY-RUN BY DEFAULT. Pass --apply to actually delete.
#
# Usage:
#   GITLAB_TOKEN=… tools/prune-gitlab-releases.sh [keep] [--apply]
#   tools/prune-gitlab-releases.sh 3           # show what would go
#   tools/prune-gitlab-releases.sh 3 --apply   # do it
set -euo pipefail

PROJ="brainstorm-os%2Fshell"
API="https://gitlab.com/api/v4"
PKG_NAME="brainstorm"

: "${GITLAB_TOKEN:?GITLAB_TOKEN must be set}"

KEEP=3
APPLY=0
for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;;
    ''|*[!0-9]*) ;;
    *) KEEP="$a" ;;
  esac
done

api() { curl -s --header "PRIVATE-TOKEN: $GITLAB_TOKEN" "$@"; }

# Releases come back newest-first; anything past $KEEP is a prune candidate.
CANDIDATES=$(api "$API/projects/$PROJ/releases?per_page=100" | python3 -c "
import sys, json
keep = int('$KEEP')
rel = json.load(sys.stdin)
rel.sort(key=lambda r: r.get('released_at') or '', reverse=True)
for r in rel[keep:]:
    print(r['tag_name'])
")

if [ -z "$CANDIDATES" ]; then
  echo "nothing to prune — keeping the $KEEP most recent release(s)"
  exit 0
fi

[ "$APPLY" -eq 1 ] || echo "DRY RUN — pass --apply to delete. Keeping the $KEEP most recent."

freed=0
while IFS= read -r tag; do
  [ -n "$tag" ] || continue
  ver="${tag#v}"

  # Find the generic package version matching this release.
  pkg=$(api "$API/projects/$PROJ/packages?per_page=100" | python3 -c "
import sys, json
want = '$ver'
for p in json.load(sys.stdin):
    if p['name'] == '$PKG_NAME' and p['version'] == want:
        print(p['id']); break
")

  if [ -n "$pkg" ]; then
    size=$(api "$API/projects/$PROJ/packages/$pkg/package_files?per_page=100" | python3 -c "
import sys, json
print(sum(f.get('size') or 0 for f in json.load(sys.stdin)))
" 2>/dev/null || echo 0)
    freed=$((freed + size))
    if [ "$APPLY" -eq 1 ]; then
      api --request DELETE -o /dev/null "$API/projects/$PROJ/packages/$pkg"
      echo "  deleted package $tag ($(( size / 1048576 )) MB)"
    else
      echo "  would delete package $tag ($(( size / 1048576 )) MB)"
    fi
  else
    echo "  no package found for $tag (already pruned?)"
  fi

  if [ "$APPLY" -eq 1 ]; then
    api --request DELETE -o /dev/null "$API/projects/$PROJ/releases/$tag"
    echo "  deleted release $tag"
  else
    echo "  would delete release $tag"
  fi
done <<EOF
$CANDIDATES
EOF

echo "total: $(( freed / 1048576 )) MB $([ "$APPLY" -eq 1 ] && echo freed || echo reclaimable)"
