#!/usr/bin/env bash
# Publish a built release to GitLab.
#
# electron-builder's `generic` provider is DOWNLOAD-only — it can serve the
# update feed but cannot upload. So `package:*` builds with `--publish never`
# and this script does the publishing in two steps:
#
#   1. upload every artefact to the project's generic package registry
#   2. create the GitLab release, linking each artefact with a
#      `direct_asset_path` so it is reachable under the release's
#      /downloads/<file> path
#
# Step 2's direct_asset_path is what makes auto-update work. electron-updater
# is pointed at the *permalink*:
#
#   https://gitlab.com/brainstorm-os/shell/-/releases/permalink/latest/downloads
#
# which always resolves to the newest release, and the filenames inside
# latest.yml resolve relative to it. Without direct_asset_path those
# /downloads/<file> URLs 404 and every client silently stops updating.
#
# Usage: GITLAB_TOKEN=… tools/publish-gitlab-release.sh [version]
set -euo pipefail

PROJ="brainstorm-os%2Fshell"
API="https://gitlab.com/api/v4"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/packages/shell/dist"

: "${GITLAB_TOKEN:?GITLAB_TOKEN must be set}"

VER="${1:-$(python3 -c "import json;print(json.load(open('$ROOT/packages/shell/package.json'))['version'])")}"
TAG="v$VER"

[ -d "$DIST" ] || { echo "no build output at $DIST — run the package script first" >&2; exit 1; }

# Only ship installers and the update metadata; skip electron-builder's
# intermediate directories and unpacked trees.
#
# Two things this deliberately does NOT do:
#   * no `mapfile` — macOS ships bash 3.2, where it does not exist, and macOS
#     is the machine that builds the signed mac artefacts.
#   * no unfiltered glob — dist/ accumulates artefacts from earlier builds, and
#     uploading a stale Brainstorm-0.0.1-arm64.dmg as a $VER asset would ship a
#     release whose installers are a different build than its version claims.
FILES=""
while IFS= read -r f; do
  name="$(basename "$f")"
  case "$name" in
    latest*.yml) ;;                       # metadata carries no version in its name
    *"$VER"*)    ;;                       # artefact belongs to this version
    *) echo "  skipping stale artefact: $name" >&2; continue ;;
  esac
  FILES="$FILES$f"$'\n'
done < <(find "$DIST" -maxdepth 1 -type f \
  \( -name '*.dmg' -o -name '*.zip' -o -name '*.exe' -o -name '*.AppImage' \
     -o -name '*.deb' -o -name '*.blockmap' -o -name 'latest*.yml' \) | sort)

FILE_COUNT=$(printf '%s' "$FILES" | grep -c . || true)
[ "$FILE_COUNT" -gt 0 ] || { echo "no $VER artefacts in $DIST" >&2; exit 1; }

echo "publishing $TAG — $FILE_COUNT artefacts"

LINKS=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  name="$(basename "$f")"
  echo "  uploading $name"
  code=$(curl -s -o /dev/null -w "%{http_code}" --retry 3 --max-time 1800 \
    --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \
    --upload-file "$f" \
    "$API/projects/$PROJ/packages/generic/brainstorm/$VER/$name")
  case "$code" in
    201|200) ;;
    *) echo "  upload failed for $name (HTTP $code)" >&2; exit 1 ;;
  esac
  LINKS="$LINKS$name"$'\n'
done < <(printf '%s' "$FILES")

echo "creating release $TAG"
PAYLOAD=$(printf '%s' "$LINKS" | python3 -c "
import sys, json
ver = '$VER'; tag = '$TAG'
base = 'https://gitlab.com/api/v4/projects/$PROJ/packages/generic/brainstorm/%s/' % ver
links = []
for name in sys.stdin.read().split():
    links.append({
        'name': name,
        'url': base + name,
        # Without this the permalink /downloads/<file> path 404s and
        # auto-update breaks silently.
        'direct_asset_path': '/' + name,
        'link_type': 'package',
    })
print(json.dumps({
    'name': tag,
    'tag_name': tag,
    'description': 'Brainstorm %s' % ver,
    'assets': {'links': links},
}))
")

code=$(curl -s -o /tmp/gitlab-release.resp -w "%{http_code}" \
  --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  --header "Content-Type: application/json" \
  --data "$PAYLOAD" \
  "$API/projects/$PROJ/releases")

if [ "$code" != "201" ]; then
  echo "release creation failed (HTTP $code):" >&2
  cat /tmp/gitlab-release.resp >&2
  exit 1
fi

echo "published $TAG"
echo "  release   : https://gitlab.com/brainstorm-os/shell/-/releases/$TAG"
echo "  update feed: https://gitlab.com/brainstorm-os/shell/-/releases/permalink/latest/downloads/latest.yml"

# Each release costs ~1.7 GB against a hard namespace storage cap, so old ones
# have to go or a later publish fails on quota. Runs after a SUCCESSFUL publish
# only — pruning before the new release exists would be the wrong order if the
# upload above had failed.
if [ "${BRAINSTORM_NO_PRUNE:-0}" != "1" ]; then
  echo
  echo "pruning old releases (keeping ${BRAINSTORM_KEEP_RELEASES:-3}) — set BRAINSTORM_NO_PRUNE=1 to skip"
  "$ROOT/tools/prune-gitlab-releases.sh" "${BRAINSTORM_KEEP_RELEASES:-3}" --apply
fi
