package com.wifly.launcher;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** Instalación y desinstalación silenciosas: como Device Owner no aparece ningún diálogo. */
final class Installer {
    private static final class Wait {
        final CountDownLatch latch = new CountDownLatch(1);
        volatile int status = PackageInstaller.STATUS_FAILURE;
        volatile String message = "sin respuesta";
    }

    private static final Map<Integer, Wait> WAITS = new ConcurrentHashMap<Integer, Wait>();

    private Installer() {}

    static void onResult(int key, int status, String message) {
        Wait w = WAITS.remove(key);
        if (w == null) return;
        w.status = status;
        w.message = message;
        w.latch.countDown();
    }

    private static PendingIntent pending(Context c, int key) {
        Intent i = new Intent(c, InstallReceiver.class).putExtra("session", key);
        return PendingIntent.getBroadcast(c, key, i, PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /**
     * Instala uno o varios APK de la misma app en una sola sesión: así entran juntas la base y sus partes.
     * Devuelve null si salió bien o el motivo del error. Bloquea: no usar en el hilo principal.
     */
    static String install(Context c, List<File> apks) throws Exception {
        PackageInstaller pi = c.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        long total = 0;
        for (File f : apks) total += f.length();
        params.setSize(total);
        int id = pi.createSession(params);
        PackageInstaller.Session s = pi.openSession(id);
        boolean committed = false;
        try {
            byte[] buf = new byte[65536];
            for (int i = 0; i < apks.size(); i++) {
                File apk = apks.get(i);
                InputStream in = new FileInputStream(apk);
                try {
                    OutputStream out = s.openWrite("part" + i + ".apk", 0, apk.length());
                    try {
                        int n;
                        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                        s.fsync(out);
                    } finally {
                        out.close();
                    }
                } finally {
                    in.close();
                }
            }
            Wait w = new Wait();
            WAITS.put(id, w);
            s.commit(pending(c, id).getIntentSender());
            committed = true;
            return await(w);
        } finally {
            s.close();
            if (!committed) {
                try { pi.abandonSession(id); } catch (Exception ignored) { }
            }
        }
    }

    static String uninstall(Context c, String pkg) throws Exception {
        int key = pkg.hashCode();
        Wait w = new Wait();
        WAITS.put(key, w);
        c.getPackageManager().getPackageInstaller().uninstall(pkg, pending(c, key).getIntentSender());
        return await(w);
    }

    private static String await(Wait w) throws InterruptedException {
        if (!w.latch.await(180, TimeUnit.SECONDS)) return "tiempo de espera agotado (en modo compatible, alguien tiene que confirmar la instalación en la pantalla)";
        return w.status == PackageInstaller.STATUS_SUCCESS ? null : (w.message == null ? "error " + w.status : w.message);
    }
}
