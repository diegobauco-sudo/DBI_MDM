package com.wifly.launcher;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;

public class InstallReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context c, Intent i) {
        int status = i.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            // Sin Device Owner, Android pide confirmación en pantalla. La sesión sigue esperando el resultado final.
            Intent confirm = i.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm != null) {
                try {
                    c.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                    return;
                } catch (Exception ignored) { }
            }
        }
        Installer.onResult(i.getIntExtra("session", -1), status, i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE));
        Policy.apply(c);
        App.changed();
    }
}
