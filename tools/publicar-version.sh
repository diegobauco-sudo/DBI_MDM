#!/usr/bin/env bash
# Publica una versión nueva del servidor en GitHub. Los servidores la ven al tocar "Buscar actualizaciones".
# Uso, desde la carpeta del proyecto, con los cambios ya guardados (commit):
#   tools/publicar-version.sh 2.2.0
# La versión de server/package.json y la etiqueta tienen que coincidir: el actualizador lo verifica.
set -euo pipefail
V="${1:-}"
[[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Uso: $0 X.Y.Z"; exit 1; }
cd "$(dirname "$0")/.."
[ -z "$(git status --porcelain)" ] || { echo "Hay cambios sin guardar (commit). Guardalos antes de publicar."; exit 1; }
git rev-parse -q --verify "refs/tags/v$V" >/dev/null && { echo "La versión v$V ya existe."; exit 1; }
CUR="$(sed -n 's/.*"version": "\(.*\)".*/\1/p' server/package.json | head -1)"
if [ "$CUR" != "$V" ] && [ "$(printf '%s\n%s\n' "$CUR" "$V" | sort -V | tail -1)" != "$V" ]; then
  echo "v$V no es más nueva que la actual ($CUR)."; exit 1
fi
if [ "$CUR" != "$V" ]; then
  sed -i "s/\"version\": \"$CUR\"/\"version\": \"$V\"/" server/package.json
  git commit -qam "Versión $V"
fi
(cd server && npm test >/dev/null) || { echo "Las pruebas fallan: no se publica."; exit 1; }
git tag -a "v$V" -m "WiFly MDM $V"
git push origin HEAD "v$V"
echo "Publicada v$V."
