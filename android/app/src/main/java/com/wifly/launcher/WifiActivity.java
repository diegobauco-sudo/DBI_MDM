package com.wifly.launcher;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiConfiguration;
import android.net.wifi.WifiManager;
import android.os.Bundle;
import android.os.Handler;
import android.view.View;
import android.widget.EditText;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** WiFi propio: el usuario se conecta sin pasar por Ajustes, que quedaría fuera del kiosko. */
public class WifiActivity extends Activity {
    private enum Sec { OPEN, WEP, PSK, SAE }

    private Panel panel;
    private WifiManager wifi;
    private final Handler handler = new Handler();
    private boolean showingForm;

    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) { if (!showingForm) renderList(); }
    };

    private final Runnable rescan = new Runnable() { @Override public void run() {
        if (!showingForm) wifi.startScan();
        handler.postDelayed(this, 20000);
    }};

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        wifi = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        panel = new Panel(this, "WiFi", "Buscando redes…");
        if (!wifi.isWifiEnabled()) wifi.setWifiEnabled(true);
        Policy.ensureLocation(this);
    }

    @Override protected void onResume() {
        super.onResume();
        IntentFilter f = new IntentFilter(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION);
        f.addAction(WifiManager.NETWORK_STATE_CHANGED_ACTION);
        registerReceiver(receiver, f);
        renderList();
        handler.post(rescan);
    }

    @Override protected void onPause() {
        handler.removeCallbacks(rescan);
        unregisterReceiver(receiver);
        super.onPause();
    }

    @Override public void onBackPressed() {
        if (showingForm) {
            showingForm = false;
            renderList();
        } else {
            finish();
        }
    }

    private void renderList() {
        View focused = getCurrentFocus();
        String keep = focused instanceof android.widget.Button ? ((android.widget.Button) focused).getText().toString() : null;
        panel.clearBelowHeader();
        String current = MdmService.networkName(this);
        panel.subheading(current.isEmpty() ? "Sin conexión. Elegí una red." : "Conectado a: " + current);

        List<ScanResult> results = new ArrayList<ScanResult>();
        try {
            results.addAll(wifi.getScanResults());
        } catch (SecurityException e) {
            panel.subheading("Android no permite listar redes: falta el permiso de ubicación.");
        }
        Collections.sort(results, new Comparator<ScanResult>() {
            @Override public int compare(ScanResult a, ScanResult b) { return b.level - a.level; }
        });
        if (results.isEmpty() && android.provider.Settings.Secure.getInt(getContentResolver(), android.provider.Settings.Secure.LOCATION_MODE, 0) == 0) {
            panel.subheading("Android no muestra redes porque la ubicación del equipo está apagada. Pedile al administrador que la active.");
        }
        Set<String> seen = new HashSet<String>();
        for (final ScanResult r : results) {
            if (r.SSID == null || r.SSID.isEmpty() || !seen.add(r.SSID)) continue;
            final Sec sec = security(r);
            int bars = WifiManager.calculateSignalLevel(r.level, 5);
            String text = r.SSID + (sec == Sec.OPEN ? "   (abierta)" : "   🔒") + "   " + bars + "/4";
            android.widget.Button b = panel.button(text, new View.OnClickListener() {
                @Override public void onClick(View v) { choose(r.SSID, sec); }
            });
            if (text.equals(keep)) b.requestFocus();
        }
        panel.button("Red oculta…", new View.OnClickListener() {
            @Override public void onClick(View v) { hiddenForm(); }
        });
        panel.button("Volver", new View.OnClickListener() {
            @Override public void onClick(View v) { finish(); }
        });
    }

    private static Sec security(ScanResult r) {
        String c = r.capabilities == null ? "" : r.capabilities;
        if (c.contains("PSK")) return Sec.PSK;
        if (c.contains("SAE")) return Sec.SAE;
        if (c.contains("WEP")) return Sec.WEP;
        return Sec.OPEN;
    }

    private void choose(final String ssid, final Sec sec) {
        if (sec == Sec.OPEN) {
            connect(ssid, sec, "", false);
            return;
        }
        showingForm = true;
        panel.clearBelowHeader();
        panel.subheading("Clave de " + ssid);
        final EditText pass = panel.input("Clave", null, true);
        panel.button("Conectar", new View.OnClickListener() {
            @Override public void onClick(View v) { connect(ssid, sec, pass.getText().toString(), false); }
        });
        panel.button("Cancelar", new View.OnClickListener() {
            @Override public void onClick(View v) { onBackPressed(); }
        });
        pass.requestFocus();
    }

    private void hiddenForm() {
        showingForm = true;
        panel.clearBelowHeader();
        panel.subheading("Red oculta (WPA/WPA2; dejá la clave vacía si es abierta)");
        final EditText ssid = panel.input("Nombre de la red", null, false);
        final EditText pass = panel.input("Clave", null, true);
        panel.button("Conectar", new View.OnClickListener() {
            @Override public void onClick(View v) {
                String p = pass.getText().toString();
                connect(ssid.getText().toString().trim(), p.isEmpty() ? Sec.OPEN : Sec.PSK, p, true);
            }
        });
        panel.button("Cancelar", new View.OnClickListener() {
            @Override public void onClick(View v) { onBackPressed(); }
        });
    }

    @SuppressWarnings("deprecation")
    private void connect(String ssid, Sec sec, String pass, boolean hidden) {
        if (ssid.isEmpty()) return;
        if (sec == Sec.PSK && pass.length() < 8 || sec == Sec.SAE && pass.length() < 8) {
            panel.subheading("La clave de una red WPA tiene 8 caracteres o más.");
            return;
        }
        WifiConfiguration c = new WifiConfiguration();
        c.SSID = "\"" + ssid + "\"";
        c.hiddenSSID = hidden;
        switch (sec) {
            case OPEN:
                c.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.NONE);
                break;
            case WEP:
                c.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.NONE);
                c.wepKeys[0] = "\"" + pass + "\"";
                c.wepTxKeyIndex = 0;
                c.allowedAuthAlgorithms.set(WifiConfiguration.AuthAlgorithm.OPEN);
                c.allowedAuthAlgorithms.set(WifiConfiguration.AuthAlgorithm.SHARED);
                break;
            case PSK:
                c.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.WPA_PSK);
                c.preSharedKey = "\"" + pass + "\"";
                break;
            case SAE:
                Compat.useSae(c);
                c.preSharedKey = "\"" + pass + "\"";
                break;
        }
        int id = wifi.addNetwork(c);
        if (id < 0) id = existing(c.SSID);
        boolean ok = id >= 0 && wifi.enableNetwork(id, true);
        if (ok) wifi.reconnect();
        showingForm = false;
        renderList();
        panel.subheading(ok ? "Conectando a " + ssid + "…" : "Android rechazó la red " + ssid + ". Probá de nuevo.");
    }

    private int existing(String quoted) {
        List<WifiConfiguration> list = wifi.getConfiguredNetworks();
        if (list != null) for (WifiConfiguration w : list) if (quoted.equals(w.SSID)) return w.networkId;
        return -1;
    }
}
