package com.wifly.launcher;

import android.accessibilityservice.AccessibilityService;
import android.content.ComponentName;
import android.content.pm.PackageManager;
import android.view.KeyEvent;
import android.view.accessibility.AccessibilityEvent;

/**
 * Tercera capa. Atrapa Home antes que el firmware y cierra al instante cualquier pantalla no permitida.
 * Hace falta porque varios TV Box chinos mapean sus teclas a su launcher sin pasar por el sistema.
 * El script de instalación lo activa; no lee texto ni contenido de pantalla.
 */
public class KeyGuardService extends AccessibilityService {
    private static final int KEYCODE_ALL_APPS = 284;
    private long lastKick;

    private boolean active() {
        return Config.kiosk(this) && Policy.protectedMode(this);
    }

    @Override protected boolean onKeyEvent(KeyEvent e) {
        if (!active() || Config.inMaintenance(this)) return false;
        switch (e.getKeyCode()) {
            case KeyEvent.KEYCODE_HOME:
                if (e.getAction() == KeyEvent.ACTION_UP) Policy.goHome(this);
                return true;
            case KeyEvent.KEYCODE_SETTINGS:
            case KeyEvent.KEYCODE_ASSIST:
            case KeyEvent.KEYCODE_VOICE_ASSIST:
            case KeyEvent.KEYCODE_SEARCH:
            case KeyEvent.KEYCODE_APP_SWITCH:
            case KeyEvent.KEYCODE_TV_INPUT:
            case KeyEvent.KEYCODE_GUIDE:
            case KEYCODE_ALL_APPS:
                return true;
            default:
                return false;
        }
    }

    @Override public void onAccessibilityEvent(AccessibilityEvent e) {
        if (e == null || e.getPackageName() == null || !active()) return;
        String pkg = e.getPackageName().toString();
        CharSequence cls = e.getClassName();
        boolean recents = "com.android.systemui".equals(pkg) && cls != null && cls.toString().toLowerCase().contains("recents");
        if (recents || (!Policy.foregroundAllowed(this, pkg) && isActivity(pkg, cls))) {
            long now = System.currentTimeMillis();
            if (now - lastKick > 800) {
                lastKick = now;
                Policy.goHome(this);
            }
        }
    }

    /** Los overlays de fabricante (volumen, HDMI) también generan eventos y no deben sacar a nadie de una película. */
    private boolean isActivity(String pkg, CharSequence cls) {
        if (cls == null) return false;
        try {
            getPackageManager().getActivityInfo(new ComponentName(pkg, cls.toString()), 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    @Override public void onInterrupt() {}
}
