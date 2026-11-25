package com.wifly.launcher;

import android.app.Activity;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;

import java.util.Set;

/** Selección de apps cuando el equipo no está conectado a un servidor. */
public class AppPickerActivity extends Activity {
    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        final Panel panel = new Panel(this, "Aplicaciones visibles", "Marcá las apps que se pueden usar. El resto queda bloqueado.");
        final PackageManager pm = getPackageManager();
        final Set<String> allowed = Config.allowed(this);
        for (final String pkg : Policy.launchable(this)) {
            if (Policy.SETTINGS.contains(pkg)) continue;
            String label;
            try {
                ApplicationInfo ai = pm.getApplicationInfo(pkg, PackageManager.GET_UNINSTALLED_PACKAGES);
                label = pm.getApplicationLabel(ai).toString();
            } catch (PackageManager.NameNotFoundException e) {
                continue;
            }
            final String name = label;
            final Button[] holder = new Button[1];
            holder[0] = panel.button(mark(allowed.contains(pkg), name), new View.OnClickListener() {
                @Override public void onClick(View v) {
                    boolean on = !allowed.contains(pkg);
                    if (on) allowed.add(pkg); else allowed.remove(pkg);
                    holder[0].setText(mark(on, name));
                    Config.setLocalAllowed(AppPickerActivity.this, allowed);
                    Config.setProvisioned(AppPickerActivity.this);
                    Policy.apply(AppPickerActivity.this);
                }
            });
        }
        panel.button("Listo", new View.OnClickListener() {
            @Override public void onClick(View v) { finish(); }
        });
    }

    private static String mark(boolean on, String name) { return (on ? "☑  " : "☐  ") + name; }
}
