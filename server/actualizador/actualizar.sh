#!/usr/bin/env bash
# Actualizador de WiFly MDM. Lo ejecuta systemd (wifly-update.service) cuando el panel deja un pedido
# en updater/request.json. También se puede correr a mano: sudo ./actualizador/actualizar.sh
#
# Para actualizar: respalda los datos, pasa el código a la versión pedida (etiqueta de git), reconstruye
# y verifica que la versión nueva responda. Si no responde, vuelve a la versión anterior con sus datos.
set -uo pipefail

SERVER_DIR="${WIFLY_SERVER_DIR:-$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)}"
# Este archivo es parte del código que se actualiza: se ejecuta desde una copia para que cambiarlo
# a mitad de camino no rompa la ejecución.
if [ -z "${WIFLY_UPDATER_COPY:-}" ]; then
  COPY="$(mktemp /tmp/wifly-actualizar.XXXXXX)"
  cp "$0" "$COPY"
  WIFLY_UPDATER_COPY="$COPY" WIFLY_SERVER_DIR="$SERVER_DIR" exec bash "$COPY" "$@"
fi
trap 'rm -f "$WIFLY_UPDATER_COPY"' EXIT
REPO_DIR="$(cd "$SERVER_DIR/.." && pwd)"
U="$SERVER_DIR/updater"
BACKUPS="${WIFLY_BACKUPS:-/root/wifly-respaldos}"
KEEP="${WIFLY_KEEP_BACKUPS:-5}"
HEALTH_TIMEOUT="${WIFLY_HEALTH_TIMEOUT:-180}"
REQ="$U/request.json"
STATUS="$U/status.json"
LOGFILE="$U/.log"
NODE_UID=1000

mkdir -p "$U"
exec 9>"$U/.lock"
flock -n 9 || exit 0
[ -f "$REQ" ] || exit 0

ACTION="$(jq -r '.action // empty' "$REQ" 2>/dev/null)"
TARGET="$(jq -r '.version // empty' "$REQ" 2>/dev/null)"
rm -f "$REQ"
: > "$LOGFILE"

git_() { git -C "$REPO_DIR" "$@"; }
dc() { (cd "$SERVER_DIR" && docker compose "$@"); }
current() { echo "v$(jq -r .version "$SERVER_DIR/package.json")"; }
log() { echo "$(date '+%H:%M:%S') $*" | tee -a "$LOGFILE"; write_status "$STATE" "${MESSAGE:-}"; }

# Versiones publicadas (etiquetas vX.Y.Z) más nuevas que la instalada, de la más vieja a la más nueva.
newer() {
  local cur; cur="$(current)"
  git_ tag -l 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | while read -r t; do
    [ "$t" != "$cur" ] && [ "$(printf '%s\n%s\n' "$cur" "$t" | sort -V | tail -1)" = "$t" ] && echo "$t"
  done
}

write_status() {
  local state="$1" message="${2:-}" tmp="$U/.status.tmp" finished=null
  case "$state" in idle|done|error|rolled_back) finished="$(date +%s)000" ;; esac
  jq -n --arg state "$state" --arg message "$message" --arg target "$TARGET" --arg current "$(current)" \
    --argjson available "$(newer | jq -R . | jq -s .)" --argjson finished "$finished" \
    --argjson lastCheck "${LAST_CHECK:-null}" --rawfile log "$LOGFILE" \
    '{state:$state, message:$message, target:$target, current:$current, available:$available,
      lastCheck:$lastCheck, finishedAt:$finished, log:($log | split("\n") | map(select(length>0)))}' > "$tmp"
  chown "$NODE_UID:$NODE_UID" "$tmp" 2>/dev/null
  mv -f "$tmp" "$STATUS"
}

LAST_CHECK="$(jq -r '.lastCheck // "null"' "$STATUS" 2>/dev/null || echo null)"
[ -n "$LAST_CHECK" ] || LAST_CHECK=null

fetch() {
  if git_ fetch --tags --force --prune origin >>"$LOGFILE" 2>&1; then
    LAST_CHECK="$(date +%s)000"
    return 0
  fi
  return 1
}

healthy() {
  local want="${1#v}" deadline=$((SECONDS + HEALTH_TIMEOUT))
  while [ $SECONDS -lt $deadline ]; do
    if dc exec -T wifly node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>r.json()).then(j=>process.exit(j.version===process.argv[1]?0:1)).catch(()=>process.exit(1))" "$want" >/dev/null 2>&1; then
      return 0
    fi
    sleep 3
  done
  return 1
}

case "$ACTION" in
  check)
    STATE=checking; MESSAGE=''
    log "Buscando versiones nuevas en GitHub"
    if fetch; then
      N="$(newer | wc -l)"
      STATE=idle
      if [ "$N" -gt 0 ]; then MESSAGE="Hay $N versión(es) nueva(s). La más reciente es $(newer | tail -1)."; else MESSAGE="Estás en la última versión."; fi
      log "$MESSAGE"
    else
      STATE=error; MESSAGE='No se pudo consultar GitHub. Revisá la conexión y la clave de despliegue.'
      log "$MESSAGE"
    fi
    ;;

  update)
    STATE=updating; MESSAGE="Actualizando a $TARGET"
    if ! [[ "$TARGET" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || ! git_ rev-parse -q --verify "refs/tags/$TARGET" >/dev/null; then
      STATE=error; MESSAGE="La versión $TARGET no existe."; log "$MESSAGE"; exit 1
    fi
    PREV_REF="$(git_ rev-parse HEAD)"
    PREV="$(current)"
    log "Versión instalada: $PREV. Versión pedida: $TARGET"

    log "Deteniendo el servidor para respaldar los datos"
    dc stop wifly >>"$LOGFILE" 2>&1
    BACKUP="$BACKUPS/$(date +%Y-%m-%d_%H%M)_$PREV"
    mkdir -p "$BACKUPS"
    if ! dc cp -a wifly:/data "$BACKUP" >>"$LOGFILE" 2>&1; then
      dc start wifly >>"$LOGFILE" 2>&1
      STATE=error; MESSAGE='No se pudo respaldar. No se cambió nada.'; log "$MESSAGE"; exit 1
    fi
    log "Respaldo guardado en $BACKUP"
    ls -1dt "$BACKUPS"/*/ 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -rf

    log "Descargando $TARGET"
    if ! git_ -c advice.detachedHead=false checkout -f -q "$TARGET" >>"$LOGFILE" 2>&1; then
      dc start wifly >>"$LOGFILE" 2>&1
      STATE=error; MESSAGE="No se pudo pasar el código a $TARGET. Sigue $PREV."; log "$MESSAGE"; exit 1
    fi

    log "Reconstruyendo y arrancando (puede tardar unos minutos)"
    dc up -d --build >>"$LOGFILE" 2>&1
    if healthy "$TARGET"; then
      STATE=done; MESSAGE="Actualizado a $TARGET."
      log "$MESSAGE"
    else
      log "La versión $TARGET no respondió. Volviendo a $PREV con los datos del respaldo"
      git_ -c advice.detachedHead=false checkout -f -q "$PREV_REF" >>"$LOGFILE" 2>&1
      dc stop wifly >>"$LOGFILE" 2>&1
      dc cp -a "$BACKUP/." wifly:/data >>"$LOGFILE" 2>&1
      dc up -d --build >>"$LOGFILE" 2>&1
      if healthy "$PREV"; then
        STATE=rolled_back; MESSAGE="La actualización a $TARGET falló y se volvió a $PREV. Revisá el registro."
      else
        STATE=error; MESSAGE="La actualización falló y la vuelta a $PREV tampoco respondió. Respaldo en $BACKUP."
      fi
      log "$MESSAGE"
    fi
    ;;

  *)
    STATE=error; MESSAGE="Pedido desconocido: $ACTION"; log "$MESSAGE"
    ;;
esac
