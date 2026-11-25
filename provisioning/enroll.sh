#!/usr/bin/env bash
# Instala WiFly Launcher como Device Owner en un TV Box conectado por ADB.
# Uso:
#   ./enroll.sh --server https://mdm.tudominio.com --token TOKEN [--device IP:5555]
#               [--user tecnico --pass CLAVE] [--apk WiFlyLauncher.apk] [--keep-adb]
#   Sin --server, el equipo queda en modo local y las apps se eligen en el propio TV Box.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APK="$HERE/WiFlyLauncher.apk"; SERVER=""; TOKEN=""; DEVICE=""; USER_NAME=""; PASS=""; KEEP_ADB=0
PKG=com.wifly.launcher

while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="$2"; shift 2;;
    --token) TOKEN="$2"; shift 2;;
    --device) DEVICE="$2"; shift 2;;
    --user) USER_NAME="$2"; shift 2;;
    --pass) PASS="$2"; shift 2;;
    --apk) APK="$2"; shift 2;;
    --keep-adb) KEEP_ADB=1; shift;;
    *) echo "Opción desconocida: $1"; exit 2;;
  esac
done

die() { echo; echo "ERROR: $*"; exit 1; }
step() { echo; echo "== $*"; }
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

command -v adb >/dev/null || die "No encuentro adb. Instalá Android Platform Tools."
[ -f "$APK" ] || die "No encuentro el APK en $APK"
[ -z "$SERVER" ] || [ -n "$TOKEN" ] || die "Con --server también hace falta --token"

if [ -n "$DEVICE" ]; then
  case "$DEVICE" in *:*) adb connect "$DEVICE" >/dev/null;; esac
  ADB=(adb -s "$DEVICE")
else
  ADB=(adb)
fi
"${ADB[@]}" wait-for-device >/dev/null 2>&1 &
WAIT=$!; sleep 8; kill "$WAIT" 2>/dev/null
[ "$("${ADB[@]}" get-state 2>/dev/null)" = device ] || die "No hay un equipo autorizado. Activá la depuración y aceptá el aviso en la pantalla."
sh() { "${ADB[@]}" shell "$@" | tr -d '\r'; }

if [ -z "$USER_NAME" ]; then read -rp "Usuario para salir del kiosko: " USER_NAME; fi
if [ -z "$PASS" ]; then read -rsp "Clave para salir del kiosko (8 caracteres o más): " PASS; echo; fi
[ -n "$USER_NAME" ] && [ "${#PASS}" -ge 8 ] || die "Hacen falta usuario y una clave de 8 caracteres o más."

step "Equipo: $(sh getprop ro.product.manufacturer) $(sh getprop ro.product.model), Android $(sh getprop ro.build.version.release)"
ACCOUNTS="$(sh dumpsys account | grep -c 'Account {')"
if [ "${ACCOUNTS:-0}" -gt 0 ] && ! sh dpm list-owners 2>/dev/null | grep -q "$PKG"; then
  sh dumpsys account | grep 'Account {'
  die "El equipo tiene cuentas cargadas y Android no deja activar Device Owner. Quitalas en Ajustes o restablecé de fábrica, y volvé a correr este script. Las cuentas de cada app se cargan después."
fi

step "Instalando WiFly Launcher"
"${ADB[@]}" install -r -g "$APK" || "${ADB[@]}" install -r "$APK" || die "No se pudo instalar el APK."

step "Activando Device Owner"
COMPAT=0; RESTORE=""
OWNER="$(sh dpm set-device-owner "$PKG/.AdminReceiver" 2>&1)"
echo "$OWNER" | head -2
if ! echo "$OWNER" | grep -qiE 'success|already'; then
  if sh pm list features | grep -q 'android.software.device_admin'; then
    die "Android rechazó Device Owner. Las causas habituales son una cuenta cargada o un segundo usuario: restablecé de fábrica sin iniciar sesión y volvé a probar."
  fi
  COMPAT=1
  echo "Este firmware no permite Device Owner (le falta android.software.device_admin)."
  echo "Sigo en MODO COMPATIBLE: protección intermedia, sin instalación silenciosa de apps."
fi

step "Activando protección de teclas y mensajes sobre las apps"
sh settings put secure enabled_accessibility_services "$PKG/$PKG.KeyGuardService" >/dev/null
sh settings put secure accessibility_enabled 1 >/dev/null
sh appops set "$PKG" SYSTEM_ALERT_WINDOW allow >/dev/null
sh cmd deviceidle whitelist +"$PKG" >/dev/null 2>&1
if [ "$COMPAT" = 1 ]; then
  sh pm grant "$PKG" android.permission.WRITE_SECURE_SETTINGS || die "No se pudo conceder WRITE_SECURE_SETTINGS."
  sh appops set "$PKG" REQUEST_INSTALL_PACKAGES allow >/dev/null
  sh pm grant "$PKG" android.permission.ACCESS_FINE_LOCATION >/dev/null 2>&1
  sh settings put secure location_mode 3 >/dev/null 2>&1
fi

step "Configurando"
ARGS="--es admin_user $(quote "$USER_NAME") --es admin_pass $(quote "$PASS")"
[ "$COMPAT" = 1 ] && ARGS="$ARGS --ez compat true"
[ -n "$SERVER" ] && ARGS="$ARGS --es server $(quote "$SERVER") --es token $(quote "$TOKEN")"
RESULT="$(sh "am broadcast -n $PKG/.ProvisionReceiver $ARGS")"
echo "$RESULT" | sed -E 's/admin_pass[^ ]*//'
echo "$RESULT" | grep -q 'data="ok' || die "El equipo no aceptó la configuración. Si indicaste servidor, revisá que el TV Box tenga internet y que el token siga vigente."
[ -z "$SERVER" ] || echo "$RESULT" | grep -q 'managed=true' || die "El equipo no quedó registrado en el servidor."

if [ "$COMPAT" = 1 ]; then
  step "Desactivando el launcher original"
  HOMES="$(echo "$RESULT" | sed -nE 's/.*homes=([^ "]*).*/\1/p' | tr ',' ' ')"
  for H in $HOMES; do
    sh pm disable-user --user 0 "$H"
    RESTORE="$RESTORE adb shell pm enable $H;"
  done
  sh cmd package set-home-activity "$PKG/.MainActivity" >/dev/null 2>&1
  [ -n "$HOMES" ] && echo "Para recuperar el launcher original más adelante:$RESTORE"
fi

step "Abriendo el kiosko"
sh am start -n "$PKG/.MainActivity" >/dev/null
sleep 4
if [ "$COMPAT" = 1 ]; then
  echo "Modo compatible activo. Probá Home dentro de una app: tiene que volver a WiFly."
else
LOCK="$(sh dumpsys activity activities | grep -E 'mLockTaskModeState|mLockTaskPackages' | head -2)"
echo "$LOCK"
if echo "$LOCK" | grep -q 'mLockTaskModeState=NONE'; then
  echo "AVISO: Lock Task no aparece activo. Probá Home con el control antes de entregar el equipo."
else
  echo "Lock Task activo."
fi
fi

step "Cerrando"
if [ "$KEEP_ADB" = 1 ]; then
  sh "am broadcast -n $PKG/.ProvisionReceiver --ez finish true --ez adb_allowed true" >/dev/null
  echo "ADB queda abierto para pruebas. Cerralo antes de entregar el equipo."
else
  sh "am broadcast -n $PKG/.ProvisionReceiver --ez finish true" >/dev/null
  echo "ADB se cierra en unos segundos. Para reabrirlo: menú de administrador en el TV Box."
fi
echo; echo "Listo. Probá con el control: Home dentro de una app, Atrás, y la secuencia de salida."
