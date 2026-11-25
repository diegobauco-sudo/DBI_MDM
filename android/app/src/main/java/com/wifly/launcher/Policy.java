package com.wifly.launcher;

import android.app.ActivityManager;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.os.Build;
import android.os.UserManager;
import android.provider.Settings;
import android.util.Log;
import android.view.inputmethod.InputMethodInfo;
import android.view.inputmethod.InputMethodManager;

import org.json.JSONArray;

import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * El corazón del kiosko. Tres capas contra la fuga por Home:
 *  1. Lock Task: el sistema rechaza abrir cualquier paquete fuera de la lista.
 *  2. Launcher fijado (persistent preferred) y launchers originales ocultos: Home no tiene otro destino.
 *  3. Vigilante en MdmService y KeyGuardService: si un firmware ignora lo anterior, vuelve a WiFly.
 */
final class Policy {
    private static final String TAG = "WiFly";
    private static final int GET_HIDDEN = PackageManager.GET_UNINSTALLED_PACKAGES;

    /** Sin estos, los inicios de sesión de Google y otras cuentas no abren dentro del kiosko. */
    static final Set<String> HELPERS = new HashSet<String>(Arrays.asList(
        "com.google.android.gms",
        "com.google.android.gsf",
        "com.google.android.gsf.login",
        "com.google.android.webview",
        "com.android.webview",
        "com.google.android.permissioncontroller",
        "com.android.permissioncontroller",
        "com.android.packageinstaller",
        "com.google.android.packageinstaller",
        "com.android.providers.downloads",
        "com.android.providers.media",
        "com.google.android.tts"));

    /** Ajustes no se oculta porque aloja la pantalla FallbackHome del arranque; lo frena Lock Task. */
    static final Set<String> SETTINGS = new HashSet<String>(Arrays.asList(
        "com.android.settings",
        "com.android.tv.settings",
        "com.google.android.tv.settings",
        "com.droidlogic.tv.settings"));

    /** Quedan instalados y actualizándose, pero nunca en la lista de Lock Task. */
    private static final Set<String> NEVER_HIDE = new HashSet<String>(Arrays.asList(
        "android",
        "com.android.systemui",
        "com.android.vending",
        "com.google.android.katniss",
        "com.android.shell"));

    private static final String[] RESTRICTIONS = {
        UserManager.DISALLOW_FACTORY_RESET,
        UserManager.DISALLOW_SAFE_BOOT,
        UserManager.DISALLOW_ADD_USER,
        UserManager.DISALLOW_REMOVE_USER,
        UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES,
        UserManager.DISALLOW_USB_FILE_TRANSFER,
        UserManager.DISALLOW_MOUNT_PHYSICAL_MEDIA,
        UserManager.DISALLOW_CONFIG_TETHERING,
    };

    private Policy() {}

    static ComponentName admin(Context c) { return new ComponentName(c, AdminReceiver.class); }
    static DevicePolicyManager dpm(Context c) { return (DevicePolicyManager) c.getSystemService(Context.DEVICE_POLICY_SERVICE); }
    static boolean isOwner(Context c) { return dpm(c).isDeviceOwnerApp(c.getPackageName()); }

    /** Sin Device Owner pero preparado por ADB: la protección depende de la guardia de teclas. */
    static boolean compatMode(Context c) { return !isOwner(c) && Config.compat(c); }
    static boolean protectedMode(Context c) { return isOwner(c) || Config.compat(c); }
    static String mode(Context c) { return isOwner(c) ? "owner" : Config.compat(c) ? "compat" : "none"; }

    static boolean canWriteSecure(Context c) {
        return c.checkSelfPermission("android.permission.WRITE_SECURE_SETTINGS") == PackageManager.PERMISSION_GRANTED;
    }

    /** Vuelve a encender la guardia si alguien la apagó. Requiere WRITE_SECURE_SETTINGS, concedido por ADB al instalar. */
    static void ensureGuard(Context c) {
        if (!canWriteSecure(c)) return;
        ContentResolver cr = c.getContentResolver();
        String me = c.getPackageName() + "/" + KeyGuardService.class.getName();
        String cur = Settings.Secure.getString(cr, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        if (cur == null || !cur.contains(c.getPackageName() + "/")) {
            Settings.Secure.putString(cr, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, cur == null || cur.isEmpty() ? me : cur + ":" + me);
        }
        if (Settings.Secure.getInt(cr, Settings.Secure.ACCESSIBILITY_ENABLED, 0) != 1) {
            Settings.Secure.putInt(cr, Settings.Secure.ACCESSIBILITY_ENABLED, 1);
        }
    }

    /**
     * Android 9 y 10 solo entregan la lista de redes WiFi con la ubicación encendida, y muchos TV Box la traen apagada.
     * Device Owner la enciende por la política; en modo compatible, por ajustes seguros.
     */
    @SuppressWarnings("deprecation")
    static void ensureLocation(Context c) {
        try {
            ContentResolver cr = c.getContentResolver();
            if (Settings.Secure.getInt(cr, Settings.Secure.LOCATION_MODE, 0) != 0) return;
            if (isOwner(c)) {
                if (Build.VERSION.SDK_INT >= 30) Compat.setLocationEnabled(dpm(c), admin(c));
                else dpm(c).setSecureSetting(admin(c), Settings.Secure.LOCATION_MODE, "3");
            } else if (canWriteSecure(c)) {
                Settings.Secure.putInt(cr, Settings.Secure.LOCATION_MODE, 3);
            }
        } catch (Exception e) {
            Log.w(TAG, "ubicación: " + e);
        }
    }

    /** En modo compatible no hay DevicePolicyManager: se protege con la guardia y se abre o cierra ADB por ajustes globales. */
    static synchronized void applyCompat(Context c) {
        try {
            if (Config.kiosk(c)) ensureGuard(c);
            ensureLocation(c);
            setAdb(c, Config.adbAllowed(c) || !Config.kiosk(c));
        } catch (Exception e) {
            Log.e(TAG, "applyCompat", e);
        }
    }

    private static void setAdb(Context c, boolean on) {
        if (!canWriteSecure(c)) return;
        ContentResolver cr = c.getContentResolver();
        if (on) {
            Settings.Global.putInt(cr, Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, 1);
            Settings.Global.putInt(cr, Settings.Global.ADB_ENABLED, 1);
        } else {
            Settings.Global.putInt(cr, Settings.Global.ADB_ENABLED, 0);
            Settings.Global.putInt(cr, Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, 0);
        }
    }

    /** Launchers distintos de WiFly y de Ajustes: en modo compatible el script de instalación los desactiva. */
    static String otherHomes(Context c) {
        StringBuilder sb = new StringBuilder();
        Intent i = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME);
        Set<String> seen = new HashSet<String>();
        for (ResolveInfo r : c.getPackageManager().queryIntentActivities(i, 0)) {
            String pkg = r.activityInfo.packageName;
            if (pkg.equals(c.getPackageName()) || SETTINGS.contains(pkg) || !seen.add(pkg)) continue;
            if (sb.length() > 0) sb.append(',');
            sb.append(pkg);
        }
        return sb.toString();
    }

    static boolean inLockTask(Context c) {
        ActivityManager am = (ActivityManager) c.getSystemService(Context.ACTIVITY_SERVICE);
        return am.getLockTaskModeState() != ActivityManager.LOCK_TASK_MODE_NONE;
    }

    private static Set<String> helpers(Context c) {
        Set<String> s = new HashSet<String>(HELPERS);
        JSONArray a = Config.remote(c).optJSONArray("helpers");
        if (a != null) for (int i = 0; i < a.length(); i++) s.add(a.optString(i));
        return s;
    }

    private static Set<String> imes(Context c) {
        Set<String> s = new HashSet<String>();
        InputMethodManager m = (InputMethodManager) c.getSystemService(Context.INPUT_METHOD_SERVICE);
        for (InputMethodInfo i : m.getInputMethodList()) s.add(i.getPackageName());
        return s;
    }

    /** ¿Puede este paquete estar al frente ahora? Lo usa el vigilante. */
    static boolean foregroundAllowed(Context c, String pkg) {
        if (pkg == null || pkg.equals(c.getPackageName())) return true;
        if ("android".equals(pkg) || "com.android.systemui".equals(pkg)) return true;
        if (imes(c).contains(pkg)) return true;
        if (Config.inMaintenance(c)) return true;
        if (Config.blocked(c)) return false;
        return Config.allowed(c).contains(pkg) || helpers(c).contains(pkg);
    }

    /** Idempotente: se llama al arrancar, al cambiar la configuración y al instalarse una app. */
    static synchronized void apply(Context c) {
        if (!isOwner(c)) {
            if (Config.compat(c)) applyCompat(c);
            return;
        }
        try {
            if (!Config.kiosk(c)) {
                release(c);
                return;
            }
            DevicePolicyManager d = dpm(c);
            ComponentName a = admin(c);
            setHomeEnabled(c, true);

            Set<String> allowed = Config.allowed(c);
            Set<String> lock = new LinkedHashSet<String>();
            lock.add(c.getPackageName());
            boolean maintenance = Config.inMaintenance(c);
            if (!Config.blocked(c)) {
                lock.addAll(allowed);
                lock.addAll(helpers(c));
                if (maintenance) lock.addAll(SETTINGS);
            }
            d.setLockTaskPackages(a, lock.toArray(new String[0]));
            Compat.setLockTaskFeatures(d, a, Compat.LOCK_TASK_FEATURE_HOME | Compat.LOCK_TASK_FEATURE_GLOBAL_ACTIONS);

            pinHome(c);
            try {
                hideOthers(c, allowed);
            } catch (Exception e) {
                Log.e(TAG, "hideOthers", e);
            }

            for (String r : RESTRICTIONS) d.addUserRestriction(a, r);
            if (Config.adbAllowed(c)) d.clearUserRestriction(a, UserManager.DISALLOW_DEBUGGING_FEATURES);
            else d.addUserRestriction(a, UserManager.DISALLOW_DEBUGGING_FEATURES);

            d.setKeyguardDisabled(a, true);
            d.setStatusBarDisabled(a, true);
            d.setPermissionPolicy(a, DevicePolicyManager.PERMISSION_POLICY_AUTO_GRANT);
            grantSelf(c);
            ensureLocation(c);
        } catch (Exception e) {
            Log.e(TAG, "apply", e);
        }
    }

    private static void pinHome(Context c) {
        IntentFilter f = new IntentFilter(Intent.ACTION_MAIN);
        f.addCategory(Intent.CATEGORY_HOME);
        f.addCategory(Intent.CATEGORY_DEFAULT);
        DevicePolicyManager d = dpm(c);
        d.clearPackagePersistentPreferredActivities(admin(c), c.getPackageName());
        d.addPersistentPreferredActivity(admin(c), f, new ComponentName(c, MainActivity.class));
    }

    private static void grantSelf(Context c) {
        for (String p : new String[]{"android.permission.ACCESS_FINE_LOCATION", "android.permission.ACCESS_COARSE_LOCATION"}) {
            dpm(c).setPermissionGrantState(admin(c), c.getPackageName(), p, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED);
        }
    }

    /** Oculta todo lo que tenga pantalla de inicio y no esté permitido, launchers originales incluidos. */
    private static void hideOthers(Context c, Set<String> allowed) {
        Set<String> keep = new HashSet<String>(allowed);
        keep.add(c.getPackageName());
        keep.addAll(helpers(c));
        keep.addAll(SETTINGS);
        keep.addAll(NEVER_HIDE);
        keep.addAll(imes(c));

        Set<String> want = new HashSet<String>();
        for (String pkg : launchable(c)) if (!keep.contains(pkg)) want.add(pkg);

        DevicePolicyManager d = dpm(c);
        Set<String> previous = Config.hiddenByUs(c);
        Set<String> hidden = new HashSet<String>();
        for (String pkg : want) {
            if (d.setApplicationHidden(admin(c), pkg, true) || d.isApplicationHidden(admin(c), pkg)) hidden.add(pkg);
        }
        for (String pkg : previous) {
            if (!hidden.contains(pkg)) d.setApplicationHidden(admin(c), pkg, false);
        }
        Config.setHiddenByUs(c, hidden);
    }

    /** Paquetes con actividad de inicio, HOME o LAUNCHER, incluidos los ya ocultos. */
    static Set<String> launchable(Context c) {
        PackageManager pm = c.getPackageManager();
        Set<String> out = new LinkedHashSet<String>();
        for (String cat : new String[]{Intent.CATEGORY_LEANBACK_LAUNCHER, Intent.CATEGORY_LAUNCHER, Intent.CATEGORY_HOME}) {
            Intent i = new Intent(Intent.ACTION_MAIN).addCategory(cat);
            List<ResolveInfo> list = pm.queryIntentActivities(i, GET_HIDDEN);
            for (ResolveInfo r : list) out.add(r.activityInfo.packageName);
        }
        out.remove(c.getPackageName());
        return out;
    }

    static boolean isInstalled(Context c, String pkg) {
        try {
            ApplicationInfo ai = c.getPackageManager().getApplicationInfo(pkg, GET_HIDDEN);
            return (ai.flags & ApplicationInfo.FLAG_INSTALLED) != 0;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    static void setHomeEnabled(Context c, boolean on) {
        c.getPackageManager().setComponentEnabledSetting(
            new ComponentName(c, MainActivity.class),
            on ? PackageManager.COMPONENT_ENABLED_STATE_ENABLED : PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
            PackageManager.DONT_KILL_APP);
    }

    /** Devuelve el equipo a su estado original. WiFly sigue como Device Owner salvo decommission(). */
    static synchronized void release(Context c) {
        if (!isOwner(c)) return;
        DevicePolicyManager d = dpm(c);
        ComponentName a = admin(c);
        try {
            d.setLockTaskPackages(a, new String[0]);
            d.clearPackagePersistentPreferredActivities(a, c.getPackageName());
            for (String pkg : Config.hiddenByUs(c)) d.setApplicationHidden(a, pkg, false);
            Config.setHiddenByUs(c, new HashSet<String>());
            for (String r : RESTRICTIONS) d.clearUserRestriction(a, r);
            d.clearUserRestriction(a, UserManager.DISALLOW_DEBUGGING_FEATURES);
            d.setKeyguardDisabled(a, false);
            d.setStatusBarDisabled(a, false);
            d.setPermissionPolicy(a, DevicePolicyManager.PERMISSION_POLICY_PROMPT);
            setHomeEnabled(c, false);
        } catch (Exception e) {
            Log.e(TAG, "release", e);
        }
    }

    /** Deja de ser Device Owner. Después de esto la app se puede desinstalar normalmente. */
    static synchronized void decommission(Context c) {
        Config.setKiosk(c, false);
        if (compatMode(c)) {
            setAdb(c, true);
            Config.setCompat(c, false);
        }
        release(c);
        if (isOwner(c)) dpm(c).clearDeviceOwnerApp(c.getPackageName());
    }

    static void goHome(Context c) {
        c.startActivity(new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }

    /** Abre el launcher del fabricante después de salir del kiosko. */
    static boolean openOriginalHome(Context c) {
        PackageManager pm = c.getPackageManager();
        Intent i = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME);
        for (ResolveInfo r : pm.queryIntentActivities(i, PackageManager.MATCH_DEFAULT_ONLY)) {
            String pkg = r.activityInfo.packageName;
            if (pkg.equals(c.getPackageName()) || SETTINGS.contains(pkg)) continue;
            c.startActivity(new Intent(i).setClassName(pkg, r.activityInfo.name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            return true;
        }
        return false;
    }

    static int sdk() { return Build.VERSION.SDK_INT; }
}
