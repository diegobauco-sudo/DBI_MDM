package com.wifly.launcher;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Configuración inicial desde adb:
 * adb shell am broadcast -n com.wifly.launcher/.ProvisionReceiver --es server URL --es token T --es admin_user U --es admin_pass P
 * Último paso, que cierra ADB salvo que se pida lo contrario:
 * adb shell am broadcast -n com.wifly.launcher/.ProvisionReceiver --ez finish true [--ez adb_allowed true]
 */
public class ProvisionReceiver extends BroadcastReceiver {
    @Override public void onReceive(final Context c, final Intent i) {
        final PendingResult r = goAsync();
        new Thread(new Runnable() { @Override public void run() {
            try {
                String user = i.getStringExtra("admin_user");
                String pass = i.getStringExtra("admin_pass");
                if (user != null && pass != null && !pass.isEmpty()) Config.setLocalCredentials(c, user, pass);
                if (i.hasExtra("compat")) Config.setCompat(c, i.getBooleanExtra("compat", false));
                if (i.hasExtra("adb_allowed")) Config.setAdbOverride(c, i.getBooleanExtra("adb_allowed", false));
                String server = i.getStringExtra("server");
                String token = i.getStringExtra("token");
                if (server != null && token != null) {
                    Net.enroll(c, server, token);
                }
                if (i.getBooleanExtra("finish", false)) {
                    Config.setProvisioned(c);
                    // Se demora para que adb reciba la respuesta antes de que se cierre la depuración.
                    new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(new Runnable() {
                        @Override public void run() { Policy.apply(c); }
                    }, 3000);
                } else {
                    Policy.apply(c);
                }
                Compat.startService(c);
                r.setResultCode(1);
                r.setResultData("ok managed=" + Config.managed(c) + " owner=" + Policy.isOwner(c)
                    + " mode=" + Policy.mode(c) + " homes=" + Policy.otherHomes(c));
            } catch (Exception e) {
                Log.e("WiFly", "provision", e);
                r.setResultCode(0);
                r.setResultData("error " + e.getMessage());
            } finally {
                r.finish();
            }
        }}).start();
    }
}
