#!/usr/bin/env bash
# Build a pinned EKG database from the manifest corpus and snapshot it.
#
#   research/scripts/build-ekg-snapshot.sh [--groups "hdm std-2025 dib"] [--ocr]
#
# Steps: verify the corpus against the manifest, build the TypeScript
# workspaces, ingest each corpus group into a fresh SQLite store with the
# real ingestion CLI, then take a verified `ekg-db backup`. The `ekg`
# condition in the Inspect task runs the MCP gateway over stdio against the
# resulting snapshots/ekg-caltrans.db (or a restored copy of the backup).
#
# OCR is disabled by default so a scanned page stays needs-ocr instead of
# adding minutes per plan set; pass --ocr to let an installed engine run.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
RESEARCH=$(cd "$HERE/.." && pwd)
ROOT=$(cd "$RESEARCH/.." && pwd)
RAW="$RESEARCH/corpus/raw"
OUT="$RESEARCH/snapshots"
DB="$OUT/ekg-caltrans.db"
# (not GROUPS: that is a bash builtin array and assignments to it are ignored)
INGEST_GROUPS="hdm std-2025 dib"   # benchmark corpus; add std-2018 / district3 with --groups for the grounding study
# The combined HDM is the same content as the chapter files; ingesting both
# would double every HDM passage in retrieval.
EXCLUDE="hdm-combined"
OCR=0

while [ $# -gt 0 ]; do
  case "$1" in
    --groups) INGEST_GROUPS="$2"; shift 2 ;;
    --ocr) OCR=1; shift ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
done

echo "== verify corpus against manifest"
(cd "$RESEARCH" && uv run caltrans-bench manifest verify)

echo "== build workspaces"
(cd "$ROOT" && npm run build --workspace @ekg/core --workspace @ekg/store-sqlite --workspace @ekg/ingestion --workspace @ekg/mcp-server >/dev/null)

mkdir -p "$OUT"
rm -f "$DB" "$DB-wal" "$DB-shm"
export EKG_DISABLE_OCR=$((1 - OCR))

# Stage symlinks to exactly the manifest documents we ingest, so the store
# never picks up a stray file from raw/ and excluded ids stay out.
STAGE="$OUT/stage"
rm -rf "$STAGE"
(cd "$RESEARCH" && uv run python - "$RAW" "$STAGE" "$INGEST_GROUPS" "$EXCLUDE" <<'PY'
import json, os, sys
from pathlib import Path
raw, stage = Path(sys.argv[1]), Path(sys.argv[2])
groups, exclude = sys.argv[3].split(), set(sys.argv[4].split())
docs = json.load(open("corpus/manifest.json"))["documents"]
n = 0
for d in docs:
    if d["group"] not in groups or d["id"] in exclude:
        continue
    src = raw / d["group"] / d["file"]
    if not src.exists():
        sys.exit(f"!! {d['id']} missing at {src}; run: uv run caltrans-bench manifest fetch --group {d['group']}")
    dst = stage / d["group"] / d["file"]
    dst.parent.mkdir(parents=True, exist_ok=True)
    os.symlink(src, dst)
    n += 1
print(f"staged {n} documents; excluded {sorted(exclude)}")
PY
)

for group in $INGEST_GROUPS; do
  echo "== ingest $group"
  (cd "$ROOT" && time npm run ingest --workspace @ekg/ingestion -- "$STAGE/$group" --db "$DB")
done

echo "== status"
(cd "$ROOT" && npm run db -- status --db "$DB")

STAMP=$(date -u +%Y%m%dT%H%MZ)
BACKUP="$OUT/ekg-caltrans-$STAMP.backup"
echo "== backup → $BACKUP"
(cd "$ROOT" && npm run db -- backup "$BACKUP" --db "$DB")

SHA=$(shasum -a 256 "$BACKUP" | cut -c1-64)
MANIFEST_SHA=$(shasum -a 256 "$RESEARCH/corpus/manifest.json" | cut -c1-64)
cat > "$OUT/SNAPSHOT.json" <<JSON
{
  "built": "$STAMP",
  "db": "$(basename "$DB")",
  "backup": "$(basename "$BACKUP")",
  "backup_sha256": "$SHA",
  "manifest_sha256": "$MANIFEST_SHA",
  "groups": "$INGEST_GROUPS",
  "excluded": "$EXCLUDE",
  "ocr": $OCR
}
JSON
echo "== done"; cat "$OUT/SNAPSHOT.json"
