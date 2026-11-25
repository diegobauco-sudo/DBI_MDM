package com.wifly.launcher;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.wifi.WifiConfiguration;
import android.os.Build;
import android.util.Log;

import java.lang.reflect.Constructor;
import java.lang.reflect.Method;

/** APIs posteriores a Android 6. Se llaman por reflexión para compilar y correr en todo el rango 6 a 14. */
final class Compat {
    private static final String TAG = "WiFly";
    static final int LOCK_TASK_FEATURE_HOME = 4;
    static final int LOCK_TASK_FEATURE_GLOBAL_ACTIONS = 16;
    private static final String CHANNEL = "wifly";

    private Compat() {}

    private static Object call(Object target, String name, Class<?>[] types, Object... args) {
        try {
            Method m = target.getClass().getMethod(name, types);
            return m.invoke(target, args);
        } catch (Exception e) {
            Log.w(TAG, name + " no disponible: " + e);
            return null;
        }
    }

    /** Android 9+: sin FEATURE_HOME la tecla Home queda muerta dentro de las apps. */
    static void setLockTaskFeatures(DevicePolicyManager dpm, ComponentName admin, int flags) {
        if (Build.VERSION.SDK_INT >= 28) {
            call(dpm, "setLockTaskFeatures", new Class<?>[]{ComponentName.class, int.class}, admin, flags);
        }
    }

    /** Android 11+: la lista de redes WiFi requiere ubicación activa. */
    static void setLocationEnabled(DevicePolicyManager dpm, ComponentName admin) {
        if (Build.VERSION.SDK_INT >= 30) {
            call(dpm, "setLocationEnabled", new Class<?>[]{ComponentName.class, boolean.class}, admin, true);
        }
    }

    static boolean reboot(DevicePolicyManager dpm, ComponentName admin) {
        if (Build.VERSION.SDK_INT < 24) return false;
        try {
            dpm.getClass().getMethod("reboot", ComponentName.class).invoke(dpm, admin);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "reboot: " + e);
            return false;
        }
    }

    static String wifiMac(DevicePolicyManager dpm, ComponentName admin) {
        if (Build.VERSION.SDK_INT < 24) return null;
        Object r = call(dpm, "getWifiMacAddress", new Class<?>[]{ComponentName.class}, admin);
        return r == null ? null : r.toString();
    }

    static void useSae(WifiConfiguration c) {
        if (Build.VERSION.SDK_INT >= 30) {
            call(c, "setSecurityParams", new Class<?>[]{int.class}, 4);
        } else {
            c.allowedKeyManagement.set(8);
        }
    }

    static void startService(Context c) {
        Intent i = new Intent(c, MdmService.class);
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                c.getClass().getMethod("startForegroundService", Intent.class).invoke(c, i);
            } else {
                c.startService(i);
            }
        } catch (Exception e) {
            Log.w(TAG, "startService: " + e);
        }
    }

    static Notification foregroundNotification(Context c) {
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            try {
                Class<?> cc = Class.forName("android.app.NotificationChannel");
                Constructor<?> k = cc.getConstructor(String.class, CharSequence.class, int.class);
                Object channel = k.newInstance(CHANNEL, "WiFly", 1);
                NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
                nm.getClass().getMethod("createNotificationChannel", cc).invoke(nm, channel);
                b = Notification.Builder.class.getConstructor(Context.class, String.class).newInstance(c, CHANNEL);
            } catch (Exception e) {
                b = new Notification.Builder(c);
            }
        } else {
            b = new Notification.Builder(c);
        }
        return b.setContentTitle("WiFly").setSmallIcon(R.drawable.icon).setOngoing(true).build();
    }
}
