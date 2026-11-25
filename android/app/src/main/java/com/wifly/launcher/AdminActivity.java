package com.wifly.launcher;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.widget.EditText;
import android.widget.Toast;

/** Menú del técnico. Solo se llega con usuario y clave. */
public class AdminActivity extends Activity {
    private static final long MAINTENANCE_MS = 5 * 60 * 1000L;
    private Panel panel;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        panel = new Panel(this, "Administrador WiFly", "");
    }

    @Override protected void onResume() {
        super.onResume();
        build();
    }

    private void build() {
        panel.clearBelowHeader();
        boolean owner = Policy.isOwner(this);
        boolean kiosk = Config.kiosk(this);
        boolean managed = Config.managed(this);
        String mode = owner ? "completo (Device Owner)" : Config.compat(this) ? "compatible" : "SIN PROTECCIÓN";
        panel.subheading("Protección: " + mode + "   ·   Kiosko: " + (kiosk ? "activo" : "desactivado")
            + "   ·   Servidor: " + (managed ? Config.server(this) : "sin conectar"));

        if (kiosk) {
            panel.button("Salir al launcher original", new View.OnClickListener() {
                @Override public void onClick(View v) {
                    confirm("¿Salir del kiosko?", "El equipo queda sin protección hasta reactivar el kiosko.", new Runnable() {
                        @Override public void run() { leave(false); }
                    });
                }
            });
            panel.button("Salir hasta el próximo reinicio", new View.OnClickListener() {
                @Override public void onClick(View v) { leave(true); }
            });
            panel.button("Abrir Ajustes de Android (5 minutos)", new View.OnClickListener() {
                @Override public void onClick(View v) { openSettings(); }
            });
        } else {
            panel.button("Reactivar kiosko", new View.OnClickListener() {
                @Override public void onClick(View v) {
                    MdmService.enterKiosk(AdminActivity.this);
                    finish();
                }
            });
        }
        if (!managed) {
            panel.button("Elegir aplicaciones visibles", new View.OnClickListener() {
                @Override public void onClick(View v) { startActivity(new Intent(AdminActivity.this, AppPickerActivity.class)); }
            });
        }
        panel.button(managed ? "Cambiar de servidor" : "Conectar con WiFly MDM", new View.OnClickListener() {
            @Override public void onClick(View v) { startActivity(new Intent(AdminActivity.this, EnrollActivity.class)); }
        });
        panel.button("WiFi", new View.OnClickListener() {
            @Override public void onClick(View v) { startActivity(new Intent(AdminActivity.this, WifiActivity.class)); }
        });
        panel.button("Cambiar usuario y clave", new View.OnClickListener() {
            @Override public void onClick(View v) { changeCredentials(); }
        });
        final boolean adb = Config.adbAllowed(this);
        panel.button(adb ? "Bloquear depuración USB y red (ADB)" : "Permitir depuración USB y red (ADB)", new View.OnClickListener() {
            @Override public void onClick(View v) {
                Config.setAdbOverride(AdminActivity.this, !adb);
                Policy.apply(AdminActivity.this);
                build();
            }
        });
        if (Policy.protectedMode(this)) {
            panel.button("Dar de baja este equipo", new View.OnClickListener() {
                @Override public void onClick(View v) {
                    confirm("¿Dar de baja?", "WiFly deja de ser Device Owner. Para volver a usarlo hay que instalarlo de nuevo con el script.", new Runnable() {
                        @Override public void run() {
                            Policy.decommission(AdminActivity.this);
                            Policy.openOriginalHome(AdminActivity.this);
                            finish();
                        }
                    });
                }
            });
        }
        panel.button("Volver", new View.OnClickListener() {
            @Override public void onClick(View v) { finish(); }
        }).requestFocus();
    }

    private void confirm(String title, String body, final Runnable yes) {
        new AlertDialog.Builder(this).setTitle(title).setMessage(body)
            .setNegativeButton("Cancelar", null)
            .setPositiveButton("Confirmar", new DialogInterface.OnClickListener() {
                @Override public void onClick(DialogInterface d, int w) { yes.run(); }
            }).show();
    }

    private void leave(boolean relock) {
        Config.setKiosk(this, false);
        Config.setRelockOnBoot(this, relock);
        stopLockTaskSafe();
        Policy.release(this);
        Policy.apply(this);
        App.changed();
        if (!Policy.openOriginalHome(this)) {
            startActivity(new Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }
        finish();
    }

    private void stopLockTaskSafe() {
        try { stopLockTask(); } catch (Exception ignored) { }
    }

    private void openSettings() {
        Config.setMaintenanceUntil(this, System.currentTimeMillis() + MAINTENANCE_MS);
        Policy.apply(this);
        try {
            startActivity(new Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception e) {
            Toast.makeText(this, "Este equipo no expone Ajustes", Toast.LENGTH_LONG).show();
        }
    }

    private void changeCredentials() {
        panel.clearBelowHeader();
        panel.subheading(Config.managed(this)
            ? "El servidor puede reemplazar estos datos al sincronizar el perfil."
            : "Mínimo 8 caracteres.");
        final EditText u = panel.input("Usuario nuevo", null, false);
        final EditText p = panel.input("Clave nueva (mínimo 8 caracteres)", null, true);
        final EditText r = panel.input("Repetir clave", null, true);
        panel.button("Guardar", new View.OnClickListener() {
            @Override public void onClick(View v) {
                final String user = u.getText().toString().trim();
                final String pass = p.getText().toString();
                if (user.isEmpty() || pass.length() < 8 || !pass.equals(r.getText().toString())) {
                    panel.subheading("Revisá los datos: usuario requerido, clave de 8 caracteres o más, y que ambas coincidan.");
                    return;
                }
                new Thread(new Runnable() { @Override public void run() {
                    try {
                        Config.setLocalCredentials(AdminActivity.this, user, pass);
                    } catch (Exception ignored) { }
                    runOnUiThread(new Runnable() { @Override public void run() {
                        App.changed();
                        build();
                    } });
                }}).start();
            }
        });
        panel.button("Cancelar", new View.OnClickListener() {
            @Override public void onClick(View v) { build(); }
        });
    }
}
