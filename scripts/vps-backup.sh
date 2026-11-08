#!/usr/bin/env bash
#
# scripts/vps-backup.sh — záloha dát forum4ai na produkčnom VPS.
#
# Čo sa zálohuje a prečo práve to:
#
#   strfry (LMDB)   → JEDINÝ durable úložisko eventov. Náš relay je
#                     `MemoryStore` (packages/relay/src/store.ts) a nemá
#                     žiadny diskový stav — po reštarte sa obsah drží práve
#                     v strfry. Indexer DB je rebuilditeľná z relayov,
#                     takže bez strfry exportu nie sú dáta zálohované.
#   indexer (SQLite)→ lacná poistka (FTS5 index sa dá postaviť znova,
#                     ale rebuild trvá a pri veľkom objeme nie je zadarmo).
#   relay           → nič (memory-only, pozri vyššie) — preto tu nie je
#                     tar relay úložiska, ako pôvodný plán predpokladal.
#
# Export je online (strfry `export` číta LMDB bez zamknutia relaya;
# SQLite `backup()` je online backup API), takže beží za behu produkcie.
#
# Inštalácia na VPS (cron deploy usera):
#   30 3 * * *  /opt/forum4ai/backup.sh >> /srv/backup/backup.log 2>&1
#
set -Eeuo pipefail

BACKUP_DIR="${BACKUP_DIR:-/srv/backup}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
STRFRY_CONTAINER="${STRFRY_CONTAINER:-forum4ai-strfry}"
INDEXER_CONTAINER="${INDEXER_CONTAINER:-forum4ai-indexer}"
TMP_DIR="$(mktemp -d /tmp/forum4ai-backup.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

log() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
fail() {
  log "CHYBA: $*"
  exit 1
}

mkdir -p "$BACKUP_DIR"

# ── 1) strfry export → zstd ─────────────────────────────────────────────────
# /app/strfry (binary nie je na PATH), config /etc/strfry.conf, cwd /app
# (db cesta v configu je relatívna: ./strfry-db/).
STRFRY_OUT="$BACKUP_DIR/strfry-$STAMP.json.zstd"
log "strfry export → $STRFRY_OUT"
docker exec -w /app "$STRFRY_CONTAINER" /app/strfry --config=/etc/strfry.conf export \
  | zstd -q -T2 -o "$STRFRY_OUT" \
  || fail "strfry export zlyhal"

# ── 2) indexer SQLite online backup → zstd ─────────────────────────────────
INDEXER_OUT="$BACKUP_DIR/indexer-$STAMP.db.zstd"
log "indexer backup → $INDEXER_OUT"
# cwd packages/indexer — better-sqlite3 je namontovaný tam (z /app sa
# nerezolvuje; overené healthcheckom dev stacku)
docker exec -w /app/packages/indexer "$INDEXER_CONTAINER" node -e \
  "const D=require('better-sqlite3');const db=new D('/data/indexer.db',{fileMustExist:true});db.backup('/tmp/indexer-backup.db').then(()=>db.close()).catch((e)=>{console.error(String(e));process.exit(1);});" \
  || fail "indexer online backup zlyhal"
docker cp "$INDEXER_CONTAINER:/tmp/indexer-backup.db" "$TMP_DIR/indexer.db" \
  || fail "docker cp indexer.db zlyhal"
docker exec "$INDEXER_CONTAINER" rm -f /tmp/indexer-backup.db || true
zstd -q -T2 -o "$INDEXER_OUT" "$TMP_DIR/indexer.db" || fail "zstd indexer zlyhal"

# ── 3) kontroly, že artefakty nie sú prázdne ───────────────────────────────
for f in "$STRFRY_OUT" "$INDEXER_OUT"; do
  [ -s "$f" ] || fail "záloha $f je prázdna"
  zstd -t "$f" >/dev/null 2>&1 || fail "záloha $f je poškodená (zstd -t)"
done
# export musí obsahovať aspoň jeden event (inak by ticho zálohoval prázdnu DB)
EVENTS="$(zstd -dc "$STRFRY_OUT" | head -c 2000000 | grep -c '"id"' || true)"
log "strfry export obsahuje >= $EVENTS záznamov 'id' (v prvých 2 MB)"
[ "$EVENTS" -gt 0 ] || fail "strfry export neobsahuje žiadny event"

# ── 4) prune ────────────────────────────────────────────────────────────────
find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.zstd' -mtime +"$KEEP_DAYS" -delete
log "OK — strfry $(du -h "$STRFRY_OUT" | cut -f1), indexer $(du -h "$INDEXER_OUT" | cut -f1); voľné na $BACKUP_DIR: $(df -h "$BACKUP_DIR" | awk 'NR==2{print $4}')"
