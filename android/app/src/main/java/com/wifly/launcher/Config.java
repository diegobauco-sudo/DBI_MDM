package com.wifly.launcher;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.security.SecureRandom;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.Set;

/** Estado persistente. El bloqueo se guarda acá para sobrevivir a reinicios y a cortes de internet. */
final class Config {
    private static final int ITERATIONS = 60000;
    static final String DEFAULT_USER = "admin";
    static final String DEFAULT_PASS = "wifly-cambiar";

    private Config() {}

    static SharedPreferences p(Context c) {
        return c.getApplicationContext().getSharedPreferences("wifly", Context.MODE_PRIVATE);
    }

    static String server(Context c) { return p(c).getString("server", ""); }
    static String deviceToken(Context c) { return p(c).getString("device_token", ""); }
    static boolean managed(Context c) { return !server(c).isEmpty() && !deviceToken(c).isEmpty(); }
    static boolean kiosk(Context c) { return p(c).getBoolean("kiosk", true); }
    static void setKiosk(Context c, boolean on) { p(c).edit().putBoolean("kiosk", on).apply(); }
    static boolean relockOnBoot(Context c) { return p(c).getBoolean("relock_boot", false); }
    static void setRelockOnBoot(Context c, boolean on) { p(c).edit().putBoolean("relock_boot", on).apply(); }

    /** Modo compatible: equipos cuyo firmware no permite Device Owner (sin android.software.device_admin). */
    static boolean compat(Context c) { return p(c).getBoolean("compat", false); }
    static void setCompat(Context c, boolean on) { p(c).edit().putBoolean("compat", on).apply(); }

    static long maintenanceUntil(Context c) { return p(c).getLong("maintenance", 0); }
    static void setMaintenanceUntil(Context c, long t) { p(c).edit().putLong("maintenance", t).apply(); }
    static boolean inMaintenance(Context c) { return System.currentTimeMillis() < maintenanceUntil(c); }

    static String installId(Context c) {
        String id = p(c).getString("install_id", "");
        if (id.isEmpty()) {
            byte[] b = new byte[16];
            new SecureRandom().nextBytes(b);
            id = Crypto.hex(b);
            p(c).edit().putString("install_id", id).apply();
        }
        return id;
    }

    static JSONObject remote(Context c) {
        try {
            return new JSONObject(p(c).getString("remote", "{}"));
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    static void setRemote(Context c, JSONObject o) {
        p(c).edit().putString("remote", o.toString()).putString("remote_version", o.optString("version")).apply();
    }

    static String remoteVersion(Context c) { return p(c).getString("remote_version", ""); }
    static boolean blocked(Context c) { return remote(c).optBoolean("blocked", false); }
    /** Hasta terminar la instalación ADB sigue abierto: si se cerrara antes, el script se quedaría a mitad de camino. */
    static boolean provisioned(Context c) { return p(c).getBoolean("provisioned", false); }
    static void setProvisioned(Context c) { p(c).edit().putBoolean("provisioned", true).apply(); }
    static boolean adbAllowed(Context c) {
        return !provisioned(c) || p(c).getBoolean("adb_override", false) || remote(c).optBoolean("adbAllowed", false);
    }
    static void setAdbOverride(Context c, boolean on) { p(c).edit().putBoolean("adb_override", on).apply(); }

    /** Apps visibles, en el orden en que deben mostrarse. */
    static Set<String> allowed(Context c) {
        Set<String> out = new LinkedHashSet<String>();
        if (managed(c)) {
            JSONArray a = remote(c).optJSONArray("apps");
            if (a != null) {
                for (int i = 0; i < a.length(); i++) {
                    JSONObject o = a.optJSONObject(i);
                    if (o != null && !o.optString("package").isEmpty()) out.add(o.optString("package"));
                }
            }
        } else {
            out.addAll(p(c).getStringSet("local_allowed", Collections.<String>emptySet()));
        }
        return out;
    }

    static void setLocalAllowed(Context c, Set<String> s) {
        p(c).edit().putStringSet("local_allowed", new HashSet<String>(s)).apply();
    }

    static Set<String> hiddenByUs(Context c) {
        return new HashSet<String>(p(c).getStringSet("hidden", Collections.<String>emptySet()));
    }

    static void setHiddenByUs(Context c, Set<String> s) {
        p(c).edit().putStringSet("hidden", new HashSet<String>(s)).apply();
    }

    // ---- Credenciales de salida --------------------------------------------------------------

    static void setLocalCredentials(Context c, String user, String pass) throws Exception {
        byte[] salt = new byte[16];
        new SecureRandom().nextBytes(salt);
        p(c).edit()
            .putString("exit_user", user)
            .putString("exit_salt", Crypto.hex(salt))
            .putInt("exit_iter", ITERATIONS)
            .putString("exit_hash", Crypto.hex(Crypto.pbkdf2(pass, salt, ITERATIONS)))
            .apply();
    }

    static void setRemoteCredentials(Context c, JSONObject exit) {
        if (exit == null || exit.optString("hash").isEmpty()) return;
        p(c).edit()
            .putString("exit_user", exit.optString("user"))
            .putString("exit_salt", exit.optString("salt"))
            .putInt("exit_iter", exit.optInt("iter", ITERATIONS))
            .putString("exit_hash", exit.optString("hash"))
            .apply();
    }

    static boolean usingDefaultCredentials(Context c) { return p(c).getString("exit_hash", "").isEmpty(); }

    /** Trabajo pesado (PBKDF2): llamar fuera del hilo principal. */
    static boolean checkCredentials(Context c, String user, String pass) throws Exception {
        SharedPreferences s = p(c);
        String hash = s.getString("exit_hash", "");
        if (hash.isEmpty()) return DEFAULT_USER.equals(user) && DEFAULT_PASS.equals(pass);
        byte[] got = Crypto.pbkdf2(pass, Crypto.unhex(s.getString("exit_salt", "")), s.getInt("exit_iter", ITERATIONS));
        boolean userOk = s.getString("exit_user", "").equals(user);
        return Crypto.same(got, Crypto.unhex(hash)) && userOk;
    }

    /** Milisegundos de espera restantes tras intentos fallidos; persiste entre reinicios. */
    static long loginWait(Context c) {
        return Math.max(0, p(c).getLong("login_until", 0) - System.currentTimeMillis());
    }

    static void loginFailed(Context c) {
        SharedPreferences s = p(c);
        int n = s.getInt("login_fails", 0) + 1;
        long wait = n < 5 ? 0 : Math.min(3600000L, 60000L << Math.min(n - 5, 6));
        s.edit().putInt("login_fails", n).putLong("login_until", System.currentTimeMillis() + wait).apply();
    }

    static void loginOk(Context c) { p(c).edit().remove("login_fails").remove("login_until").apply(); }
}
