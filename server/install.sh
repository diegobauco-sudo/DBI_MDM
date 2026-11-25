#!/usr/bin/env bash
# Instala WiFly MDM en un servidor Ubuntu o Debian limpio. Uso: sudo ./install.sh mdm.tudominio.com
set -euo pipefail
cd "$(dirname "$0")"
DOMAIN="${1:-}"
[ -n "$DOMAIN" ] || { echo "Uso: sudo ./install.sh mdm.tudominio.com"; exit 1; }
[ "$(id -u)" = 0 ] || { echo "Ejecutalo con sudo."; exit 1; }
if ! docker compose version >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq docker.io docker-compose-v2
  systemctl enable --now docker
fi
if [ ! -f .env ]; then
  PASS="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
  printf 'DOMAIN=%s\nADMIN_USER=admin\nADMIN_PASSWORD=%s\n' "$DOMAIN" "$PASS" > .env
  chmod 600 .env
  echo "Usuario: admin"
  echo "Clave inicial: $PASS   (cambiala en el panel, sección Cuenta)"
fi
docker compose up -d --build
echo "Panel: https://$DOMAIN   (el dominio tiene que apuntar a este servidor, con los puertos 80 y 443 abiertos)"
