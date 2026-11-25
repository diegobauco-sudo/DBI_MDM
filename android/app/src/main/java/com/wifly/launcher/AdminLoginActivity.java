package com.wifly.launcher;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;

/** La única puerta de salida del kiosko. */
public class AdminLoginActivity extends Activity {
    private Panel panel;
    private EditText user;
    private EditText pass;
    private Button enter;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        panel = new Panel(this, "Administrador", "Ingresá usuario y clave.");
        user = panel.input("Usuario", null, false);
        pass = panel.input("Clave", null, true);
        enter = panel.button("Entrar", new View.OnClickListener() {
            @Override public void onClick(View v) { attempt(); }
        });
        panel.button("Cancelar", new View.OnClickListener() {
            @Override public void onClick(View v) { finish(); }
        });
    }

    private void attempt() {
        long wait = Config.loginWait(this);
        if (wait > 0) {
            panel.subheading("Demasiados intentos. Probá de nuevo en " + (wait / 1000 + 1) + " segundos.");
            return;
        }
        final String u = user.getText().toString().trim();
        final String p = pass.getText().toString();
        enter.setEnabled(false);
        panel.subheading("Verificando…");
        new Thread(new Runnable() { @Override public void run() {
            boolean ok;
            try {
                ok = Config.checkCredentials(AdminLoginActivity.this, u, p);
            } catch (Exception e) {
                ok = false;
            }
            final boolean result = ok;
            runOnUiThread(new Runnable() { @Override public void run() { done(result); } });
        }}).start();
    }

    private void done(boolean ok) {
        enter.setEnabled(true);
        pass.setText("");
        if (ok) {
            Config.loginOk(this);
            startActivity(new Intent(this, AdminActivity.class).putExtra("auth", true));
            finish();
        } else {
            Config.loginFailed(this);
            panel.subheading("Usuario o clave incorrectos.");
        }
    }
}
