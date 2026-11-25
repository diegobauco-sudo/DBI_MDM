# WiFly - enrolamiento de TV Box por ADB (Windows)
# Se ejecuta con enrolar.bat. Lee config.txt de esta misma carpeta.
# Compatible con Windows PowerShell 5.1 (el que trae Windows 10 y 11).

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Pkg = 'com.wifly.launcher'
$Log = Join-Path $Here 'registro.csv'

function Say($text, $color) { if ($color) { Write-Host $text -ForegroundColor $color } else { Write-Host $text } }
function Step($text) { Write-Host ''; Write-Host "  > $text" -ForegroundColor Cyan }
# Los errores previstos usan ApplicationException; cualquier otro es inesperado.
function Fail($text) { throw (New-Object System.ApplicationException $text) }

# ---- Configuración -------------------------------------------------------------------------
function Read-Config {
    $file = Join-Path $Here 'config.txt'
    if (-not (Test-Path $file)) {
        Say "No encuentro config.txt en $Here" Red
        Say 'Copiá config-ejemplo.txt como config.txt y completalo.' Yellow
        exit 1
    }
    $cfg = @{}
    foreach ($line in Get-Content -Path $file -Encoding UTF8) {
        $l = $line.Trim()
        if ($l -eq '' -or $l.StartsWith('#')) { continue }
        $i = $l.IndexOf('=')
        if ($i -gt 0) { $cfg[$l.Substring(0, $i).Trim().ToUpper()] = $l.Substring($i + 1).Trim() }
    }
    $errors = @()
    if ($cfg['SERVIDOR'] -notmatch '^https?://[A-Za-z0-9.\-]+(:[0-9]+)?/?$') { $errors += 'SERVIDOR tiene que ser una dirección como https://hmdm.wifly.net.ar' }
    if ($cfg['TOKEN'] -notmatch '^[A-Za-z0-9_\-]{6,}$') { $errors += 'TOKEN falta o tiene caracteres inválidos (copialo de Alta de equipos)' }
    if ($cfg['USUARIO'] -notmatch '^[A-Za-z0-9_\-]{1,40}$') { $errors += 'USUARIO falta o tiene caracteres no permitidos (solo letras, números, guion y guion bajo)' }
    if ($cfg['CLAVE'] -notmatch '^[A-Za-z0-9_\-]{8,}$') { $errors += 'CLAVE tiene que tener 8 caracteres o más, solo letras, números, guion y guion bajo' }
    if (-not $cfg['CERRAR_ADB']) { $cfg['CERRAR_ADB'] = 'preguntar' }
    $cfg['CERRAR_ADB'] = $cfg['CERRAR_ADB'].ToLower()
    if (@('si', 'no', 'preguntar') -notcontains $cfg['CERRAR_ADB']) { $errors += 'CERRAR_ADB tiene que ser si, no o preguntar' }
    if ($errors.Count) {
        Say 'Revisá config.txt:' Red
        foreach ($e in $errors) { Say "  - $e" Red }
        exit 1
    }
    $cfg['SERVIDOR'] = $cfg['SERVIDOR'].TrimEnd('/')
    return $cfg
}

function Find-Adb {
    if ($env:WIFLY_ADB) { return $env:WIFLY_ADB }
    foreach ($p in @((Join-Path $Here 'adb.exe'), 'C:\platform-tools\adb.exe')) { if (Test-Path $p) { return $p } }
    $cmd = Get-Command adb -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    Say 'No encuentro adb.exe. Poné esta carpeta dentro de C:\platform-tools, o copiá adb.exe y sus DLL acá.' Red
    exit 1
}

function Find-Apk {
    $apk = Get-ChildItem -Path $Here -Filter 'WiFlyLauncher*.apk' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $apk) { Say "No encuentro WiFlyLauncher*.apk en $Here" Red; exit 1 }
    return $apk.FullName
}

# ---- ADB --------------------------------------------------------------------------------------
# Se lanza como proceso y se leen salida y errores por separado: en PowerShell 5.1, redirigir los
# mensajes de error de adb con 2>&1 corta el script.
function Adb([string[]]$ArgList) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $script:AdbExe
    $psi.Arguments = ($ArgList | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $out = $p.StandardOutput.ReadToEndAsync()
    $err = $p.StandardError.ReadToEndAsync()
    $p.WaitForExit()
    return ($out.Result + "`n" + $err.Result).Trim()
}
function Shell($serial, [string]$command) { return Adb @('-s', $serial, 'shell', $command) }

function Connect-Device([string]$target) {
    if ($target -eq '') {
        $lines = (Adb @('devices')) -split "`n" | Select-Object -Skip 1 | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }
        $usb = @($lines | Where-Object { $_ -notmatch ':' })
        if ($usb.Count -eq 0) { Fail 'No hay ningún TV Box conectado por cable. Revisá el cable de datos, el puerto y que la Depuración USB esté activada.' }
        if ($usb.Count -gt 1) { Fail 'Hay más de un equipo conectado por cable. Dejá uno solo.' }
        $serial = ($usb[0] -split '\s+')[0]
    } else {
        $serial = if ($target -match ':') { $target } else { "${target}:5555" }
        $r = Adb @('connect', $serial)
        if ($r -match 'refused|denegó|10061') { Fail 'El equipo rechazó la conexión: ADB por red está apagado. Activalo (o conectalo por cable y corré adb tcpip 5555) y probá de nuevo.' }
        if ($r -match 'No route|timed out|unreachable|tiempo') { Fail "No llego al equipo $serial. Revisá la IP y que la PC esté en la misma red." }
        if ($r -notmatch 'connected|conectado') { Fail "No se pudo conectar: $r" }
    }
    for ($i = 0; $i -lt 30; $i++) {
        $state = Adb @('-s', $serial, 'get-state')
        if ($state -eq 'device') { return $serial }
        if ($i -eq 0 -and $state -match 'unauthorized') { Say '    Aceptá el aviso de depuración en la pantalla del TV Box (marcá "Permitir siempre")...' Yellow }
        Start-Sleep -Seconds 2
    }
    Fail 'El equipo no autorizó la conexión. Aceptá el aviso en la pantalla del TV Box y probá de nuevo.'
}

# ---- Enrolamiento -----------------------------------------------------------------------------
function Enroll([string]$target) {
    $info = [ordered]@{ fecha = (Get-Date -Format 'yyyy-MM-dd HH:mm'); equipo = $(if ($target) { $target } else { 'cable USB' }); modelo = ''; android = ''; modo = ''; resultado = 'ERROR'; detalle = '' }
    try {
        Step 'Conectando'
        $s = Connect-Device $target
        $info.modelo = Shell $s 'getprop ro.product.model'
        $info.android = Shell $s 'getprop ro.build.version.release'
        Say "    $($info.modelo), Android $($info.android)"

        $full = (Shell $s 'pm list features') -match 'android.software.device_admin'
        if ($full) {
            $accounts = Shell $s 'dumpsys account'
            if ($accounts -match 'Accounts:\s*([1-9][0-9]*)') {
                $owners = Shell $s 'dumpsys device_policy'
                if ($owners -notmatch $Pkg) { Fail 'El equipo tiene cuentas cargadas. Restablecelo de fábrica sin iniciar sesión y probá de nuevo.' }
            }
        }

        Step 'Instalando WiFly'
        $r = Adb @('-s', $s, 'install', '-r', '-g', $script:Apk)
        if ($r -notmatch 'Success') { Fail "No se pudo instalar el APK: $r" }

        if ($full) {
            Step 'Activando protección completa (Device Owner)'
            $r = Shell $s "dpm set-device-owner $Pkg/.AdminReceiver"
            if ($r -notmatch 'Success|already') { Fail "Android rechazó Device Owner. Restablecé de fábrica sin iniciar sesión y probá de nuevo. ($($r.Split("`n")[0]))" }
            $info.modo = 'completo'
        } else {
            Step 'Este modelo no admite Device Owner: modo compatible'
            $r = Shell $s "pm grant $Pkg android.permission.WRITE_SECURE_SETTINGS"
            if ($r -match 'Exception|Error') { Fail "No se pudo dar el permiso de ajustes: $r" }
            Shell $s "appops set $Pkg REQUEST_INSTALL_PACKAGES allow" | Out-Null
            $info.modo = 'compatible'
        }

        Step 'Configurando permisos'
        Shell $s "appops set $Pkg SYSTEM_ALERT_WINDOW allow" | Out-Null
        Shell $s "settings put secure enabled_accessibility_services $Pkg/$Pkg.KeyGuardService" | Out-Null
        Shell $s 'settings put secure accessibility_enabled 1' | Out-Null
        Shell $s 'settings put secure location_mode 3' | Out-Null
        Shell $s "cmd deviceidle whitelist +$Pkg" | Out-Null

        Step 'Registrando en el panel'
        $c = $script:Cfg
        $compat = if ($full) { '' } else { ' --ez compat true' }
        $r = Shell $s "am broadcast -n $Pkg/.ProvisionReceiver --es admin_user $($c['USUARIO']) --es admin_pass $($c['CLAVE'])$compat --es server $($c['SERVIDOR']) --es token $($c['TOKEN'])"
        if ($r -notmatch 'data="ok') { Fail 'El equipo no aceptó la configuración.' }
        if ($r -notmatch 'managed=true') { Fail 'El equipo no quedó registrado en el panel. Revisá que tenga internet y que el token siga vigente.' }
        Say '    Registrado.' Green

        if (-not $full) {
            Step 'Desactivando el launcher original'
            $homes = ''
            if ($r -match 'homes=([^ "]*)') { $homes = $Matches[1] }
            foreach ($h in ($homes -split ',' | Where-Object { $_ -ne '' })) {
                $d = Shell $s "pm disable-user --user 0 $h"
                if ($d -match 'disabled') { Say "    $h desactivado" } else { Say "    No se pudo desactivar $h ($d)" Yellow }
                $info.detalle += "launcher desactivado: $h; "
            }
            Shell $s "cmd package set-home-activity $Pkg/.MainActivity" | Out-Null
        }

        Step 'Abriendo WiFly'
        Shell $s "am broadcast -n $Pkg/.ProvisionReceiver --ez finish true --ez adb_allowed true" | Out-Null
        Shell $s "am start -n $Pkg/.MainActivity" | Out-Null
        Start-Sleep -Seconds 3
        if ($full) {
            $lock = Shell $s 'dumpsys activity activities'
            if ($lock -match 'mLockTaskModeState=NONE') { Say '    Aviso: el kiosko todavía no aparece activo. Probá Home con el control.' Yellow }
        }

        $close = $c['CERRAR_ADB']
        if ($close -eq 'preguntar') {
            Say ''
            Say '    Probá Home con el control antes de cerrar ADB.' Yellow
            $ans = Read-Host '    ¿Cerrar ADB ahora? (s/n)'
            $close = if ($ans -match '^[sS]') { 'si' } else { 'no' }
        }
        if ($close -eq 'si') {
            Shell $s "am broadcast -n $Pkg/.ProvisionReceiver --ez finish true --ez adb_allowed false" | Out-Null
            if ($s -match ':') { Adb @('disconnect', $s) | Out-Null }
            Say '    ADB cerrado. Para reabrirlo: menú de administrador del TV Box o el panel.'
            $info.detalle += 'ADB cerrado'
        } else {
            Say '    ADB queda abierto. Cerralo antes de entregar el equipo.' Yellow
            $info.detalle += 'ADB abierto'
        }
        $info.resultado = 'OK'
        Say ''
        Say "  LISTO: $($info.modelo) instalado en modo $($info.modo)." Green
    } catch [System.ApplicationException] {
        $info.detalle = $_.Exception.Message
        Say ''
        Say "  ERROR: $($_.Exception.Message)" Red
    } catch {
        $info.detalle = "Error inesperado: $($_.Exception.Message)"
        Say ''
        Say "  ERROR: $($info.detalle)" Red
    }
    [pscustomobject]$info | Export-Csv -Path $Log -Append -NoTypeInformation -Encoding UTF8
    return [pscustomobject]$info
}

# ---- Programa ---------------------------------------------------------------------------------
$script:Cfg = Read-Config
$script:AdbExe = Find-Adb
$script:Apk = Find-Apk
Adb @('start-server') | Out-Null

Say ''
Say '  WiFly - enrolamiento de TV Box' Cyan
Say "  Servidor: $($Cfg['SERVIDOR'])"
Say "  APK:      $(Split-Path -Leaf $Apk)"
Say "  Registro: $(Split-Path -Leaf $Log)"

$results = @()
while ($true) {
    Say ''
    Say '  Escribí la IP del TV Box, o:' Cyan
    Say '    Enter = equipo conectado por cable'
    Say '    L     = instalar todos los de lista-ip.txt'
    Say '    S     = salir'
    $in = (Read-Host '  IP').Trim()
    if ($in -match '^[sS]$') { break }
    if ($in -match '^[lL]$') {
        $listFile = Join-Path $Here 'lista-ip.txt'
        if (-not (Test-Path $listFile)) { Say '  No existe lista-ip.txt (una IP por línea).' Red; continue }
        $ips = Get-Content $listFile | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' -and -not $_.StartsWith('#') }
        foreach ($ip in $ips) {
            Say ''
            Say "  ===== $ip =====" Cyan
            $results += Enroll $ip
        }
        continue
    }
    if ($in -ne '' -and $in -notmatch '^[0-9]{1,3}(\.[0-9]{1,3}){3}(:[0-9]+)?$') { Say '  Eso no parece una IP. Ejemplo: 192.168.11.202' Red; continue }
    $results += Enroll $in
}

if ($results.Count) {
    Say ''
    Say '  Resumen' Cyan
    foreach ($r in $results) {
        $color = if ($r.resultado -eq 'OK') { 'Green' } else { 'Red' }
        Say ("    {0,-5} {1,-22} {2,-12} {3,-11} {4}" -f $r.resultado, $r.equipo, $r.modelo, $r.modo, $r.detalle) $color
    }
    $ok = @($results | Where-Object { $_.resultado -eq 'OK' }).Count
    Say "    $ok de $($results.Count) equipos instalados. El detalle queda en registro.csv."
}
