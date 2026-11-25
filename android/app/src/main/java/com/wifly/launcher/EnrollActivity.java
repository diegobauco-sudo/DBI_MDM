package com.wifly.launcher;

import android.app.Activity;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;

public class EnrollActivity extends Activity {
    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        final Panel panel = new Panel(this, "Conectar con WiFly MDM", "Los datos están en el panel, sección Enrolamiento.");
        final EditText url = panel.input("Dirección del servidor (https://…)", Config.server(this), false);
        final EditText token = panel.input("Token de enrolamiento", null, false);
        final Button[] go = new Button[1];
        go[0] = panel.button("Conectar", new View.OnClickListener() {
            @Override public void onClick(View v) {
                final String u = url.getText().toString().trim();
                final String t = token.getText().toString().trim();
                go[0].setEnabled(false);
                panel.subheading("Conectando…");
                new Thread(new Runnable() { @Override public void run() {
                    String error = null;
                    try {
                        Net.enroll(EnrollActivity.this, u, t);
                        Config.setProvisioned(EnrollActivity.this);
                        Compat.startService(EnrollActivity.this);
                    } catch (Exception e) {
                        error = e.getMessage();
                    }
                    final String err = error;
                    runOnUiThread(new Runnable() { @Override public void run() {
                        go[0].setEnabled(true);
                        if (err == null) finish();
                        else panel.subheading("No se pudo conectar: " + err);
                    }});
                }}).start();
            }
        });
        panel.button("Cancelar", new View.OnClickListener() {
            @Override public void onClick(View v) { finish(); }
        });
    }
}
