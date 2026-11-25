# WiFly Launcher y WiFly MDM

- **WiFly Launcher** (`provisioning/WiFlyLauncher.apk`): launcher de kiosko para TV Box con Android 6 o superior.
- **WiFly MDM** (`server/`): panel web para administrar los equipos, mensajes, bloqueos, apps y fondos.

## Estado de las pruebas

El APK compila, está firmado y pasa la validación de `apksigner`, pero **no se ejecutó en un TV Box ni en un emulador**. El servidor y el panel sí se probaron completos con equipos simulados. Antes de instalar en cantidad, hacé la [prueba de un equipo](#prueba-de-un-equipo).

## Por qué Home no se escapa

El agente libre de Headwind no usa Lock Task: sin eso, Home sale del launcher. WiFly usa tres capas:

1. **Lock Task con Device Owner.** Android rechaza abrir cualquier paquete fuera de la lista, sin importar qué tecla se apriete.
2. **Launcher fijado.** WiFly queda como Home persistente y los launchers originales se ocultan. Home no tiene otro destino.
3. **Protección de teclas y vigilante.** Un servicio atrapa Home antes que el firmware y cierra cualquier pantalla no permitida. Otro vigilante reactiva Lock Task si se cae.

Device Owner es necesario para la protección completa. Algunos TV Box baratos traen un firmware sin la función que lo permite: para ellos existe el modo compatible.

## Modo compatible (TV Box sin Device Owner)

Para saber si un modelo admite la protección completa, con ADB conectado:

```bash
adb shell pm list features | grep device_admin
```

Si no responde nada, el firmware no tiene `android.software.device_admin` y ninguna app puede ser Device Owner. `enroll.sh` lo detecta solo y pasa a **modo compatible**:

- Desactiva el launcher original y deja WiFly como única pantalla de inicio.
- La protección de teclas devuelve a WiFly ante Home y cierra cualquier app no permitida o Ajustes. Si alguien la apaga, WiFly la vuelve a encender.
- Funcionan las apps del perfil, el fondo, los mensajes, el bloqueo y el cierre de ADB.
- **Diferencias con el modo completo:** instalar o desinstalar apps pide confirmación en la pantalla del TV Box, no se puede reiniciar desde el panel, y alguien con conocimientos podría encontrar un atajo del fabricante hacia Ajustes. El panel lo marca en cada equipo.

El script muestra el comando para recuperar el launcher original (`adb shell pm enable ...`). Antes de comprar una tanda, conviene probar el modelo con el comando de arriba y preferir los que admiten la protección completa.

## 1. Instalar el servidor

Necesitás un servidor con Ubuntu 24.04 (VM o CT de Proxmox con nesting y keyctl), y un dominio que apunte a él, con los puertos 80 y 443 abiertos.

```bash
cd server
sudo ./install.sh mdm.tudominio.com
```

El script instala Docker, obtiene el certificado HTTPS y muestra la clave inicial. Cambiala en **Cuenta**.

### Probar en tu red local, sin dominio

Requiere Node 22.13 o superior.

```bash
cd server
npm ci --omit=dev
ADMIN_PASSWORD=una-clave-larga npm start
```

El panel queda en `http://IP-DE-TU-PC:8080`. Sin HTTPS, alguien en la misma red puede ver o modificar lo que viaja: usalo solo para probar.

## 2. Preparar el perfil

En el panel, **Perfiles**:

1. Subí la imagen de fondo.
2. Marcá las apps permitidas. Aparecen cuando un equipo las informa o cuando subís el APK a **Biblioteca**. También podés escribir el paquete, por ejemplo `com.netflix.ninja`.
3. Definí usuario y clave de salida.

En **Alta de equipos**, creá un token.

## 3. Instalar en un TV Box

Necesitás [Android Platform Tools](https://developer.android.com/tools/releases/platform-tools) en tu PC.

1. En el TV Box: Ajustes, Acerca de, tocá 7 veces Compilación, y activá la depuración USB o de red.
2. **No cargues ninguna cuenta antes de instalar**: Android no permite Device Owner con cuentas. Si ya hay una, quitala o restablecé de fábrica.
3. Conectá el TV Box y corré, desde `provisioning/`:

```bash
# Linux o macOS
./enroll.sh --server https://mdm.tudominio.com --token TOKEN --device 192.168.1.50:5555

```

**En Windows**, usá el enrolador de doble clic: copiá `enrolar.bat`, `enrolar.ps1`, `config-ejemplo.txt` y el APK dentro de `C:\platform-tools`, guardá `config-ejemplo.txt` como `config.txt` con el token, el usuario y la clave, y abrí `enrolar.bat`. Pide la IP de cada TV Box (o usa el cable), detecta el modo completo o compatible, desactiva el launcher original, registra el equipo, pregunta si cerrar ADB y anota todo en `registro.csv`. Con `lista-ip.txt` instala varios equipos seguidos. Instrucciones en `provisioning/LEEME.txt`.

```bash

Sin `--device`, usa el equipo conectado por USB. Para el primer equipo agregá `--keep-adb`, así no perdés el acceso si algo falla. Cuando termina, ADB queda cerrado salvo que uses esa opción.

`enroll.sh` también funciona sin servidor: omití `--server` y `--token`, y elegí las apps en el menú de administrador del TV Box.

## Multiempresa

Desde la versión 2.0, un mismo servidor administra varias empresas por separado.

| Rol | Qué puede hacer |
|---|---|
| **Administrador general** | Crea, edita, suspende y elimina empresas; ve la facturación; define la frase de marca y los días de gracia; administra cualquier empresa eligiéndola con **Administrar**. |
| **Administrador de empresa** | Todo lo de su empresa: equipos, perfiles, biblioteca de apps, tokens de alta y operadores. No ve nada de otras empresas. |
| **Operador** | Solo envía mensajes, bloquea y desbloquea equipos de su empresa. |

- **Facturación:** se factura todo equipo registrado al menos un día del mes, aunque después se dé de baja. El primer día de cada mes, el anterior se cierra y su número ya no cambia. Se exporta a CSV para Excel, con detalle por equipo.
- **Suspensión:** al suspender una empresa, su panel se corta en el momento. Si en los días de gracia no se marca como pagada, sus TV Box muestran "Servicio suspendido, comuníquese con su proveedor". Al marcarla pagada vuelve todo.
- **Marca:** cada empresa se muestra con su nombre y la frase fija (por ejemplo "por DBI") debajo, más chica, en su panel y en sus TV Box. En el TV Box se ve desde WiFly Launcher 1.3.0.

### Actualizar un servidor 1.x a multiempresa

1. **Respaldá los datos** antes de actualizar. Dentro del CT:

   ```bash
   cd /root/wifly/server
   docker compose stop wifly
   docker compose cp wifly:/data /root/respaldo-wifly-$(date +%F)
   ```

2. **Actualizá** con el zip nuevo:

   ```bash
   cd /root
   unzip -o wiflymdm.zip
   cd wifly/server
   docker compose up -d --build
   ```

3. **Entrá con el usuario de siempre.** Ahora es administrador general. Todos los equipos, perfiles, archivos y tokens quedan en la empresa **Empresa principal**: cambiale el nombre en **Empresas, Editar**. Los equipos siguen conectados sin hacer nada.
4. En **Configuración**, cargá la frase fija y los días de gracia.

**Para volver a la versión anterior:** `docker compose down`, descomprimí el zip de la 1.2.1, copiá el respaldo de vuelta con `docker compose cp /root/respaldo-wifly-FECHA/. wifly:/data` y `docker compose up -d --build`.

## Apps divididas (.apks, .xapk, .apkm)

Muchas apps de Play Store vienen divididas en varias partes. En **Biblioteca** se pueden subir así, igual que un APK común:

- **`.apks`** (bundletool, SAI), **`.xapk`** (APKPure) y **`.apkm`** sin cifrar (APKMirror).
- El servidor revisa que todas las partes sean de la misma app y versión, y que esté la base.
- Cada TV Box descarga solo la base, las partes de idioma y pantalla, y la de **su arquitectura** (32 o 64 bits), y las instala juntas.
- Si el paquete no trae la arquitectura del equipo, la instalación falla y el motivo aparece en **Envíos**. Descargá el paquete para esa arquitectura: en TV Box baratos suele ser `armeabi-v7a`.
- Los archivos **OBB** que traen algunos `.xapk` (datos extra, sobre todo de juegos) no se instalan; el panel avisa al subirlos.

Instalar apps divididas requiere **WiFly Launcher 1.1.0** o superior en el equipo.

## Actualizar el servidor

Copiá el zip nuevo al CT como la primera vez y, dentro del CT:

```bash
cd /root
unzip -o wiflymdm.zip
cd wifly/server
docker compose up -d --build
```

Los equipos, perfiles, archivos y la clave del panel se conservan: están en el volumen de Docker y en `.env`, que el zip no trae.

## Salir del kiosko

Con el control, en la pantalla de inicio: **arriba, arriba, abajo, abajo, izquierda, derecha, izquierda, derecha**. Después pide usuario y clave. Cinco errores seguidos bloquean el ingreso durante un tiempo creciente, de 1 minuto hasta 1 hora.

El menú permite salir al launcher original, salir hasta el próximo reinicio, abrir Ajustes durante 5 minutos, cambiar de servidor, abrir o cerrar ADB y dar de baja el equipo. Para volver al kiosko, abrí WiFly Launcher desde el launcher original o usá **Activar kiosko** en el panel. Un bloqueo enviado desde el panel devuelve el equipo al kiosko.

## Prueba de un equipo

Instalá con `--keep-adb` y comprobá cada punto:

| Prueba | Resultado esperado |
|---|---|
| Home en la pantalla de inicio y dentro de una app | Vuelve a WiFly |
| Atrás en la pantalla de inicio | No pasa nada |
| Teclas de Ajustes, Apps, Google y las de marca del control | No abren nada fuera de lo permitido |
| Reiniciar el equipo | Arranca en WiFly |
| Pantalla WiFi | Lista las redes y conecta |
| Iniciar sesión en cada app, incluidas las que usan cuenta de Google | Se puede completar |
| Mensaje desde el panel, ventana y franja, con una película en curso | Aparece encima y la película sigue al cerrarlo |
| Bloquear desde el panel, reiniciar, y desbloquear | Sigue bloqueado tras reiniciar y vuelve a la normalidad |
| Secuencia de salida con usuario y clave | Abre el menú y permite volver al launcher original |
| Instalar un APK desde Biblioteca | Se instala sin preguntar |

Si una app no llega a abrir su pantalla de inicio de sesión, agregá el paquete que necesita en **Opciones avanzadas, Paquetes auxiliares**. Si algo falla, el panel muestra alertas por equipo y `adb logcat -s WiFly` da el detalle.

## Límites

- **Restablecer de fábrica desde el botón físico o el recovery** borra WiFly. Android bloquea el restablecimiento desde Ajustes, pero no el del firmware.
- **Un firmware con root** o un acceso físico avanzado pueden saltear cualquier protección.
- **Android 7 y 8** no tienen la opción de Home dentro de Lock Task: ahí Home depende de la protección de teclas. Verificalo en esos modelos.
- **Android anterior a 7.1.1** puede rechazar certificados de Let's Encrypt. Probá la conexión antes de comprar equipos así de viejos.
- **Google Play Protect** puede avisar al instalar, porque el APK no viene de Play.
- **Docker** se entregó sin ejecutar. `enroll.sh` y `enrolar.ps1` se probaron con un `adb` simulado; `enrolar.ps1`, con PowerShell 7 y sin sintaxis exclusiva de esa versión, pero no en un Windows real.
- El panel tiene un solo usuario administrador. No se midió cuántos equipos soporta un servidor.

## Compilar y firmar

En Ubuntu 24.04:

```bash
sudo apt install openjdk-21-jdk aapt apksigner dalvik-exchange zipalign android-sdk-platform-23
cd android && tools/build-apk.sh
```

Con Docker: ver `android/Dockerfile`.

**Guardá `android/wifly-release.jks` y su clave en un lugar seguro.** Android solo acepta actualizaciones firmadas con la misma clave: si la perdés, hay que reinstalar cada equipo. No la subas a un repositorio público. Para publicar una versión, subí `versionCode` en `AndroidManifest.xml`, compilá, subí el APK a **Biblioteca** y elegilo en **Actualizar WiFly Launcher** dentro del perfil.

## Pruebas del servidor

```bash
cd server && npm install && npm test
```
