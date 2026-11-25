package com.wifly.launcher;

import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.IntentFilter;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.graphics.PixelFormat;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Mantiene la conexión con WiFly MDM (long polling) y el vigilante del kiosko. */
public class MdmService extends Service {
    private static final String TAG = "WiFly";
    private static final long STATE_EVERY = 5 * 60 * 1000L;
    private static final long RECONCILE_EVERY = 30 * 60 * 1000L;
    private static final long RETRY_FAILED_INSTALL = 60 * 60 * 1000L;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<String, Long> failedInstalls = new HashMap<String, Long>();
    /** Descargas e instalaciones van aparte: un APK grande no puede demorar un bloqueo o un mensaje. */
    private final ExecutorService slow = Executors.newSingleThreadExecutor();
    private final BroadcastReceiver packageAdded = new BroadcastReceiver() {
        @Override public void onReceive(final Context c, Intent i) {
            slow.execute(new Runnable() { @Override public void run() {
                Policy.apply(c);
                App.changed();
                sendStateNow = true;
            }});
        }
    };
    private Thread worker;
    private volatile boolean running;
    private volatile boolean sendStateNow = true;
    private long lastKick;
    private boolean maintenanceWasOn;

    private final Runnable watchdog = new Runnable() { @Override public void run() {
        try { checkKiosk(); } catch (Exception e) { Log.w(TAG, "watchdog", e); }
        main.postDelayed(this, 2000);
    }};

    @Override public IBinder onBind(Intent i) { return null; }

    @Override public void onCreate() {
        super.onCreate();
        startForeground(1, Compat.foregroundNotification(this));
        running = true;
        worker = new Thread(new Runnable() { @Override public void run() { loop(); } }, "wifly-mdm");
        worker.start();
        main.post(watchdog);
        IntentFilter f = new IntentFilter(Intent.ACTION_PACKAGE_ADDED);
        f.addDataScheme("package");
        registerReceiver(packageAdded, f);
    }

    @Override public int onStartCommand(Intent i, int flags, int id) {
        sendStateNow = true;
        return START_STICKY;
    }

    @Override public void onDestroy() {
        running = false;
        main.removeCallbacks(watchdog);
        unregisterReceiver(packageAdded);
        slow.shutdown();
        if (worker != null) worker.interrupt();
        super.onDestroy();
    }

    private void checkKiosk() {
        boolean maintenance = Config.inMaintenance(this);
        if (maintenanceWasOn && !maintenance) {
            Policy.apply(this);
            Policy.goHome(this);
        }
        maintenanceWasOn = maintenance;
        if (!Config.kiosk(this) || maintenance) return;
        if (Policy.compatMode(this)) {
            Policy.ensureGuard(this);
            return;
        }
        if (!Policy.isOwner(this)) return;
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (!pm.isInteractive()) return;
        if (!Policy.inLockTask(this)) {
            long now = System.currentTimeMillis();
            if (now - lastKick > 5000) {
                lastKick = now;
                Log.w(TAG, "Lock Task inactivo: vuelvo al launcher");
                Policy.goHome(this);
            }
        }
    }

    // ---- Bucle de red ------------------------------------------------------------------------

    private void loop() {
        long backoff = 2000, lastState = 0, lastReconcile = 0;
        while (running) {
            try {
                if (!Config.managed(this)) {
                    Thread.sleep(10000);
                    continue;
                }
                long now = System.currentTimeMillis();
                if (sendStateNow || now - lastState > STATE_EVERY) {
                    sendStateNow = false;
                    sendState();
                    lastState = now;
                }
                JSONObject r = Net.json(Config.server(this), Config.deviceToken(this), "GET",
                    "/api/device/poll?cv=" + Config.remoteVersion(this), null, 45000);
                backoff = 2000;
                String version = r.optString("configVersion");
                boolean changed = !version.isEmpty() && !version.equals(Config.remoteVersion(this));
                if (changed) fetchConfig();
                JSONArray cmds = r.optJSONArray("commands");
                if (cmds != null) for (int i = 0; i < cmds.length(); i++) execute(cmds.getJSONObject(i));
                now = System.currentTimeMillis();
                if (changed || now - lastReconcile > RECONCILE_EVERY) {
                    lastReconcile = now;
                    slow.execute(new Runnable() { @Override public void run() { reconcile(); } });
                }
            } catch (InterruptedException e) {
                return;
            } catch (Net.HttpError e) {
                Log.w(TAG, "servidor: " + e.getMessage());
                // 401: el equipo fue dado de baja en el panel. Conserva su última política y reintenta espaciado.
                sleep(e.code == 401 ? 300000 : backoff);
                backoff = Math.min(backoff * 2, 60000);
            } catch (Exception e) {
                Log.w(TAG, "red: " + e);
                sleep(backoff);
                backoff = Math.min(backoff * 2, 60000);
            }
        }
    }

    private void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); running = false; }
    }

    private void fetchConfig() throws Exception {
        JSONObject cfg = Net.json(Config.server(this), Config.deviceToken(this), "GET", "/api/device/config", null, 30000);
        Config.setRemote(this, cfg);
        Config.setRemoteCredentials(this, cfg.optJSONObject("exit"));
        Policy.apply(this);
        App.changed();
        // Un bloqueo del panel gana a una salida local: el equipo vuelve al kiosko para quedar bloqueado.
        if (Config.blocked(this)) {
            if (Config.kiosk(this)) Policy.goHome(this);
            else if (Policy.protectedMode(this)) enterKiosk(this);
        }
        sendStateNow = true;
    }

    /** Lleva el equipo a lo que dice el perfil: instala, actualiza y quita apps. */
    private void reconcile() {
        JSONObject cfg = Config.remote(this);
        syncWallpaper(cfg);
        JSONArray apps = cfg.optJSONArray("apps");
        boolean touched = false;
        if (apps != null) {
            for (int i = 0; i < apps.length(); i++) {
                JSONObject a = apps.optJSONObject(i);
                if (a != null && ensureApk(a.optString("package"), a.optJSONObject("apk"))) touched = true;
            }
        }
        if (ensureApk(getPackageName(), cfg.optJSONObject("launcherApk"))) touched = true;
        JSONArray rem = cfg.optJSONArray("removePackages");
        if (rem != null) {
            for (int i = 0; i < rem.length(); i++) {
                String pkg = rem.optString(i);
                if (pkg.isEmpty() || pkg.equals(getPackageName()) || !Policy.isInstalled(this, pkg)) continue;
                try {
                    String err = Installer.uninstall(this, pkg);
                    if (err != null) Log.w(TAG, "desinstalar " + pkg + ": " + err);
                    touched = true;
                } catch (Exception e) {
                    Log.w(TAG, "desinstalar " + pkg, e);
                }
            }
        }
        if (touched) {
            Policy.apply(this);
            App.changed();
            sendStateNow = true;
        }
    }

    /** Si falla, se reintenta en la próxima reconciliación; la política ya quedó aplicada. */
    private void syncWallpaper(JSONObject cfg) {
        try {
            JSONObject wp = cfg.optJSONObject("wallpaper");
            File dest = new File(getFilesDir(), "wallpaper");
            if (wp != null && !wp.optString("sha").isEmpty()) {
                String sha = wp.getString("sha");
                if (sha.equals(Config.p(this).getString("wallpaper_sha", "")) && dest.exists()) return;
                Net.download(this, "/api/device/files/" + sha, sha, dest);
                Config.p(this).edit().putString("wallpaper_sha", sha).apply();
            } else {
                if (Config.p(this).getString("wallpaper_sha", "").isEmpty()) return;
                dest.delete();
                Config.p(this).edit().remove("wallpaper_sha").apply();
            }
            App.changed();
        } catch (Exception e) {
            Log.w(TAG, "fondo de pantalla: " + e);
        }
    }

    private int installedVersion(String pkg) {
        try {
            return getPackageManager().getPackageInfo(pkg, PackageManager.GET_UNINSTALLED_PACKAGES).versionCode;
        } catch (PackageManager.NameNotFoundException e) {
            return -1;
        }
    }

    private boolean ensureApk(String pkg, JSONObject apk) {
        if (apk == null || apk.optString("sha").isEmpty() || pkg.isEmpty()) return false;
        String sha = apk.optString("sha");
        if (installedVersion(pkg) >= apk.optInt("versionCode", 0)) return false;
        Long failedAt = failedInstalls.get(sha);
        if (failedAt != null && System.currentTimeMillis() - failedAt < RETRY_FAILED_INSTALL) return false;
        String err = installFromServer(apk);
        if (err != null) {
            Log.w(TAG, "instalar " + pkg + ": " + err);
            failedInstalls.put(sha, System.currentTimeMillis());
            return false;
        }
        return true;
    }

    /** Descarga e instala un APK común o, si trae "parts", las partes de una app dividida que sirven para este equipo. */
    private String installFromServer(JSONObject apk) {
        List<File> files = new ArrayList<File>();
        try {
            JSONArray parts = apk.optJSONArray("parts");
            if (parts == null || parts.length() == 0) {
                File f = new File(getCacheDir(), apk.getString("sha") + ".apk");
                files.add(f);
                Net.download(this, "/api/device/files/" + apk.getString("sha"), apk.getString("sha"), f);
            } else {
                String[] names = new String[parts.length()];
                for (int i = 0; i < names.length; i++) names[i] = parts.getJSONObject(i).optString("split");
                for (int i : Splits.select(names, Build.SUPPORTED_ABIS)) {
                    String sha = parts.getJSONObject(i).getString("sha");
                    File f = new File(getCacheDir(), sha + ".apk");
                    files.add(f);
                    Net.download(this, "/api/device/files/" + sha, sha, f);
                }
            }
            return Installer.install(this, files);
        } catch (Exception e) {
            return e.getMessage() != null ? e.getMessage() : e.toString();
        } finally {
            for (File f : files) f.delete();
        }
    }

    // ---- Comandos ----------------------------------------------------------------------------

    private void execute(JSONObject cmd) throws Exception {
        String id = cmd.getString("id");
        String type = cmd.optString("type");
        JSONObject p = cmd.optJSONObject("payload");
        if (p == null) p = new JSONObject();
        String error = null;
        String detail = null;
        try {
            if ("message".equals(type)) {
                detail = showMessage(id, p);
            } else if ("sync".equals(type)) {
                fetchConfig();
                sendState();
            } else if ("reboot".equals(type)) {
                report(id, null, "reiniciando");
                if (!Compat.reboot(Policy.dpm(this), Policy.admin(this))) error = "Este equipo no permite reiniciar de forma remota";
                else return;
            } else if ("install".equals(type) || "uninstall".equals(type)) {
                final String t = type, i = id;
                final JSONObject args = p;
                slow.execute(new Runnable() { @Override public void run() {
                    String err;
                    try {
                        err = "install".equals(t) ? installFromServer(args) : Installer.uninstall(MdmService.this, args.getString("package"));
                    } catch (Exception e) {
                        err = e.toString();
                    }
                    Policy.apply(MdmService.this);
                    App.changed();
                    sendStateNow = true;
                    report(i, err, null);
                }});
                return;
            } else if ("exitKiosk".equals(type)) {
                exitKiosk(p.optBoolean("relockOnBoot", false));
            } else if ("enterKiosk".equals(type)) {
                enterKiosk(this);
            } else if ("decommission".equals(type)) {
                report(id, null, "WiFly deja de administrar este equipo");
                Policy.decommission(this);
                Policy.openOriginalHome(this);
                Config.p(this).edit().remove("device_token").remove("server").apply();
                return;
            } else {
                error = "comando desconocido: " + type;
            }
        } catch (Exception e) {
            error = e.toString();
        }
        report(id, error, detail);
    }

    private void exitKiosk(boolean relock) {
        Config.setKiosk(this, false);
        Config.setRelockOnBoot(this, relock);
        Policy.release(this);
        Policy.apply(this);
        App.changed();
        if (!Policy.openOriginalHome(this)) {
            try {
                startActivity(new Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (Exception ignored) { }
        }
        sendStateNow = true;
    }

    static void enterKiosk(Context c) {
        Config.setKiosk(c, true);
        Config.setRelockOnBoot(c, false);
        Policy.apply(c);
        App.changed();
        Policy.goHome(c);
    }

    private void report(String id, String error, String detail) {
        try {
            JSONObject b = new JSONObject();
            b.put("ok", error == null);
            b.put("detail", error != null ? error : (detail == null ? "" : detail));
            Net.json(Config.server(this), Config.deviceToken(this), "POST", "/api/device/commands/" + id + "/result", b, 20000);
        } catch (Exception e) {
            Log.w(TAG, "report", e);
        }
    }

    static void reportAsync(final Context c, final String id, final String detail) {
        if (id == null || !Config.managed(c)) return;
        new Thread(new Runnable() { @Override public void run() {
            try {
                JSONObject b = new JSONObject();
                b.put("ok", true);
                b.put("detail", detail);
                Net.json(Config.server(c), Config.deviceToken(c), "POST", "/api/device/commands/" + id + "/result", b, 20000);
            } catch (Exception e) {
                Log.w(TAG, "report", e);
            }
        }}).start();
    }

    // ---- Mensajes ----------------------------------------------------------------------------

    private String showMessage(final String id, final JSONObject p) {
        final String title = p.optString("title", "Aviso");
        final String body = p.optString("body");
        final int seconds = p.optInt("seconds", 0);
        boolean canOverlay = Settings.canDrawOverlays(this);
        if ("banner".equals(p.optString("mode")) && canOverlay) {
            main.post(new Runnable() { @Override public void run() { showBanner(title, body, seconds > 0 ? seconds : 15); } });
            return "mostrado como banner";
        }
        startActivity(new Intent(this, MessageActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra("id", id).putExtra("title", title).putExtra("body", body).putExtra("seconds", seconds));
        return "banner".equals(p.optString("mode")) ? "mostrado en pantalla completa (el equipo no tiene permiso de superposición)" : "mostrado";
    }

    @SuppressWarnings("deprecation")
    private void showBanner(String title, String body, int seconds) {
        final WindowManager wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        final TextView v = new TextView(this);
        v.setText(title.isEmpty() ? body : title + "  ·  " + body);
        v.setTextColor(0xFFFFFFFF);
        v.setTextSize(20);
        v.setBackgroundColor(0xE6101A2A);
        v.setGravity(Gravity.CENTER);
        int pad = (int) (16 * getResources().getDisplayMetrics().density);
        v.setPadding(pad, pad, pad, pad);
        int type = Build.VERSION.SDK_INT >= 26 ? 2038 : WindowManager.LayoutParams.TYPE_SYSTEM_ALERT;
        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT, type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
            PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.BOTTOM;
        wm.addView(v, lp);
        main.postDelayed(new Runnable() { @Override public void run() {
            try { wm.removeView((View) v); } catch (Exception ignored) { }
        }}, seconds * 1000L);
    }

    // ---- Estado ------------------------------------------------------------------------------

    private void sendState() throws Exception {
        JSONObject s = new JSONObject();
        PackageManager pm = getPackageManager();
        PackageInfo me = pm.getPackageInfo(getPackageName(), 0);
        s.put("model", Build.MODEL);
        s.put("manufacturer", Build.MANUFACTURER);
        s.put("androidVersion", Build.VERSION.RELEASE);
        s.put("sdk", Build.VERSION.SDK_INT);
        s.put("launcherVersion", me.versionName);
        s.put("launcherVersionCode", me.versionCode);
        boolean owner = Policy.isOwner(this);
        s.put("deviceOwner", owner);
        s.put("mode", Policy.mode(this));
        s.put("kiosk", Config.kiosk(this));
        s.put("lockTask", Policy.inLockTask(this));
        s.put("blocked", Config.blocked(this));
        s.put("overlay", Settings.canDrawOverlays(this));
        s.put("keyGuard", keyGuardOn());
        s.put("adbOpen", Settings.Global.getInt(getContentResolver(), Settings.Global.ADB_ENABLED, 0) == 1);
        s.put("defaultCredentials", Config.usingDefaultCredentials(this));
        s.put("appliedConfig", Config.remoteVersion(this));
        s.put("ip", localIp());
        s.put("network", networkName(this));
        if (owner) s.put("mac", Compat.wifiMac(Policy.dpm(this), Policy.admin(this)));

        JSONArray apps = new JSONArray();
        java.util.Set<String> launchable = Policy.launchable(this);
        java.util.Set<String> homes = new java.util.HashSet<String>();
        for (android.content.pm.ResolveInfo r : pm.queryIntentActivities(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME), PackageManager.GET_UNINSTALLED_PACKAGES)) homes.add(r.activityInfo.packageName);
        for (String pkg : launchable) {
            try {
                ApplicationInfo ai = pm.getApplicationInfo(pkg, PackageManager.GET_UNINSTALLED_PACKAGES);
                if ((ai.flags & ApplicationInfo.FLAG_INSTALLED) == 0) continue;
                PackageInfo pi = pm.getPackageInfo(pkg, PackageManager.GET_UNINSTALLED_PACKAGES);
                JSONObject a = new JSONObject();
                a.put("package", pkg);
                a.put("label", pm.getApplicationLabel(ai).toString());
                a.put("version", pi.versionName);
                a.put("versionCode", pi.versionCode);
                a.put("system", (ai.flags & ApplicationInfo.FLAG_SYSTEM) != 0);
                a.put("home", homes.contains(pkg));
                a.put("hidden", owner && Policy.dpm(this).isApplicationHidden(Policy.admin(this), pkg));
                apps.put(a);
            } catch (PackageManager.NameNotFoundException ignored) { }
        }
        s.put("apps", apps);
        Net.json(Config.server(this), Config.deviceToken(this), "POST", "/api/device/state", s, 30000);
    }

    private boolean keyGuardOn() {
        String v = Settings.Secure.getString(getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        return v != null && v.contains(getPackageName());
    }

    private static String localIp() {
        try {
            for (NetworkInterface n : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!n.isUp() || n.isLoopback()) continue;
                for (InetAddress a : Collections.list(n.getInetAddresses())) {
                    if (a instanceof Inet4Address) return a.getHostAddress();
                }
            }
        } catch (Exception ignored) { }
        return "";
    }

    /** Nombre de la red para mostrar: SSID, Ethernet o vacío si no hay conexión. */
    static String networkName(Context c) {
        ConnectivityManager cm = (ConnectivityManager) c.getSystemService(Context.CONNECTIVITY_SERVICE);
        NetworkInfo n = cm.getActiveNetworkInfo();
        if (n == null || !n.isConnected()) return "";
        if (n.getType() == ConnectivityManager.TYPE_ETHERNET) return "Ethernet";
        if (n.getType() == ConnectivityManager.TYPE_WIFI) {
            WifiManager wm = (WifiManager) c.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            WifiInfo w = wm.getConnectionInfo();
            String ssid = w == null ? null : w.getSSID();
            if (ssid == null || ssid.contains("unknown")) return "WiFi";
            return ssid.replace("\"", "");
        }
        return "Conectado";
    }
}
