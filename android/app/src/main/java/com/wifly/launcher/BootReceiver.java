package com.wifly.launcher;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context c, Intent i) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(i.getAction()) && Config.relockOnBoot(c)) {
            Config.setKiosk(c, true);
            Config.setRelockOnBoot(c, false);
        }
        Config.setMaintenanceUntil(c, 0);
        Policy.apply(c);
        Compat.startService(c);
        if (Config.kiosk(c) && Policy.protectedMode(c)) Policy.goHome(c);
    }
}
