#!/usr/bin/env bash
# Activa el botón "Actualizar" del panel. Se corre una sola vez en el CT, como root:
#   sudo ./actualizador/activar-actualizaciones.sh usuario/repositorio
# Crea una clave de despliegue de solo lectura para GitHub, conecta el código con el repositorio
# e instala el servicio de systemd que atiende los pedidos del panel.
set -euo pipefail

REPO="${1:-}"
[ "$(id -u)" = 0 ] || { echo "Ejecutalo con sudo."; exit 1; }
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "Uso: sudo $0 usuario/repositorio"; exit 1; }

SERVER_DIR="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
REPO_DIR="$(cd "$SERVER_DIR/.." && pwd)"
U="$SERVER_DIR/updater"
KEY=/root/.ssh/wifly_deploy

command -v git >/dev/null && command -v jq >/dev/null || { apt-get update -qq; apt-get install -y -qq git jq; }

mkdir -p /root/.ssh && chmod 700 /root/.ssh
if [ ! -f "$KEY" ]; then
  ssh-keygen -q -t ed25519 -N '' -C "wifly-mdm $(hostname)" -f "$KEY"
fi

cd "$REPO_DIR"
[ -d .git ] || git init -q
git config core.sshCommand "ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
if git remote get-url origin >/dev/null 2>&1; then git remote set-url origin "git@github.com:$REPO.git"; else git remote add origin "git@github.com:$REPO.git"; fi

echo
echo "1. En GitHub, abrí https://github.com/$REPO/settings/keys"
echo "2. Tocá \"Add deploy key\", poné de título \"WiFly CT\", pegá esta clave y dejá SIN marcar \"Allow write access\":"
echo
cat "$KEY.pub"
echo
until git ls-remote --tags origin >/dev/null 2>&1; do
  read -rp "Cuando la hayas agregado, apretá Enter para probar la conexión... " _
done
echo "Conexión con GitHub: OK"
git fetch -q --tags --force origin

mkdir -p "$U"
chown 1000:1000 "$U"
jq -n --arg repo "$REPO" --arg at "$(date -Iseconds)" '{repo:$repo, installedAt:$at}' > "$U/updater.json"
chmod +x "$SERVER_DIR/actualizador/actualizar.sh"

cat > /etc/systemd/system/wifly-update.service <<UNIT
[Unit]
Description=Actualizador de WiFly MDM

[Service]
Type=oneshot
ExecStart=$SERVER_DIR/actualizador/actualizar.sh
UNIT
cat > /etc/systemd/system/wifly-update.path <<UNIT
[Unit]
Description=Pedidos de actualización del panel de WiFly MDM

[Path]
PathExists=$U/request.json

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now wifly-update.path

# El contenedor necesita ver la carpeta del actualizador.
(cd "$SERVER_DIR" && docker compose up -d)

echo '{"action":"check"}' > "$U/request.json"
echo
echo "Listo. En el panel: Configuración, Actualizaciones."
