#!/usr/bin/env bash
# Compila el APK sin Android Studio. Requiere en Ubuntu 24.04:
#   sudo apt install openjdk-21-jdk aapt apksigner dalvik-exchange zipalign android-sdk-platform-23
# Uso: tools/build-apk.sh [keystore] [clave]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/app/src/main"
BUILD="$ROOT/build"
JAR=/usr/lib/android-sdk/platforms/android-23/android.jar
KS="${1:-$ROOT/wifly-release.jks}"
PASS="${2:-${WIFLY_KEY_PASS:-}}"

if [ ! -f "$KS" ]; then
  [ -n "$PASS" ] || PASS="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
  keytool -genkeypair -keystore "$KS" -storetype PKCS12 -storepass "$PASS" -alias wifly \
    -keyalg RSA -keysize 3072 -validity 12000 -dname "CN=WiFly Launcher" >/dev/null 2>&1
  echo "$PASS" > "$KS.password.txt"; chmod 600 "$KS.password.txt"
  echo "Clave de firma nueva: $KS (guardala: sin ella no hay actualizaciones)"
fi
[ -n "$PASS" ] || PASS="$(cat "$KS.password.txt")"

rm -rf "$BUILD"; mkdir -p "$BUILD/gen" "$BUILD/classes"
aapt package -f -m -J "$BUILD/gen" -M "$SRC/AndroidManifest.xml" -S "$SRC/res" -I "$JAR" \
  --min-sdk-version 23 --target-sdk-version 28 -F "$BUILD/unsigned.apk"
find "$SRC/java" "$BUILD/gen" -name '*.java' > "$BUILD/sources.txt"
javac -nowarn -Xlint:-options -source 8 -target 8 -encoding UTF-8 -bootclasspath "$JAR" \
  -d "$BUILD/classes" @"$BUILD/sources.txt"
dalvik-exchange --dex --min-sdk-version=23 --output="$BUILD/classes.dex" "$BUILD/classes"
(cd "$BUILD" && aapt add -f unsigned.apk classes.dex >/dev/null)
zipalign -f -p 4 "$BUILD/unsigned.apk" "$BUILD/aligned.apk"
apksigner sign --ks "$KS" --ks-pass "pass:$PASS" --ks-key-alias wifly \
  --min-sdk-version 23 --out "$BUILD/WiFlyLauncher.apk" "$BUILD/aligned.apk"
apksigner verify "$BUILD/WiFlyLauncher.apk"
echo "Listo: $BUILD/WiFlyLauncher.apk"
