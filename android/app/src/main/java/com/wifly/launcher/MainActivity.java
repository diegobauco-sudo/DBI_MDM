package com.wifly.launcher;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.drawable.Drawable;
import android.net.ConnectivityManager;
import android.os.Bundle;
import android.util.DisplayMetrics;
import android.view.KeyEvent;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.AdapterView;
import android.widget.BaseAdapter;
import android.widget.GridView;
import android.widget.ImageView;
import android.widget.TextClock;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/** Pantalla de inicio. Basada en la idea de just-a-launcher (hungmi, MIT): una grilla simple, sin animaciones. */
public class MainActivity extends Activity {
    private static final int[] SECRET = {
        KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_UP,
        KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_DOWN,
        KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT,
        KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT};

    private static final class Tile {
        String label;
        Drawable image;
        Intent intent;
    }

    private final List<Tile> tiles = new ArrayList<Tile>();
    private GridView grid;
    private View blockedView;
    private ImageView wallpaper;
    private String wallpaperLoaded = "-";
    private int secretPos;

    private final Runnable refresh = new Runnable() { @Override public void run() { render(); } };

    private final BroadcastReceiver packages = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) { render(); }
    };

    private final BroadcastReceiver connectivity = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) { renderNetwork(); }
    };

    private final BaseAdapter adapter = new BaseAdapter() {
        @Override public int getCount() { return tiles.size(); }
        @Override public Object getItem(int p) { return tiles.get(p); }
        @Override public long getItemId(int p) { return p; }
        @Override public View getView(int p, View v, ViewGroup parent) {
            if (v == null) v = LayoutInflater.from(MainActivity.this).inflate(R.layout.tile, parent, false);
            Tile t = tiles.get(p);
            ((ImageView) v.findViewById(R.id.image)).setImageDrawable(t.image);
            ((TextView) v.findViewById(R.id.label)).setText(t.label);
            return v;
        }
    };

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        setContentView(R.layout.main);
        grid = (GridView) findViewById(R.id.grid);
        blockedView = findViewById(R.id.blocked);
        wallpaper = (ImageView) findViewById(R.id.wallpaper);
        grid.setAdapter(adapter);
        grid.setOnItemClickListener(new AdapterView.OnItemClickListener() {
            @Override public void onItemClick(AdapterView<?> a, View v, int p, long id) {
                try {
                    startActivity(tiles.get(p).intent);
                } catch (Exception e) {
                    android.widget.Toast.makeText(MainActivity.this, "No se pudo abrir la aplicación", android.widget.Toast.LENGTH_SHORT).show();
                }
            }
        });
        Compat.startService(this);
    }

    @Override protected void onStart() {
        super.onStart();
        App.listen(refresh);
        IntentFilter f = new IntentFilter();
        f.addAction(Intent.ACTION_PACKAGE_ADDED);
        f.addAction(Intent.ACTION_PACKAGE_REMOVED);
        f.addAction(Intent.ACTION_PACKAGE_CHANGED);
        f.addDataScheme("package");
        registerReceiver(packages, f);
        registerReceiver(connectivity, new IntentFilter(ConnectivityManager.CONNECTIVITY_ACTION));
    }

    @Override protected void onStop() {
        App.unlisten(refresh);
        unregisterReceiver(packages);
        unregisterReceiver(connectivity);
        super.onStop();
    }

    @Override protected void onResume() {
        super.onResume();
        if (Config.kiosk(this) && Policy.isOwner(this)) {
            if (!Policy.dpm(this).isLockTaskPermitted(getPackageName())) Policy.apply(this);
            if (!Policy.inLockTask(this) && Policy.dpm(this).isLockTaskPermitted(getPackageName())) {
                try { startLockTask(); } catch (Exception ignored) { }
            }
        } else if (Config.kiosk(this) && Policy.compatMode(this)) {
            Policy.ensureGuard(this);
        }
        render();
    }

    @Override public void onBackPressed() { /* Home no se cierra con Atrás. */ }

    @Override protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        if (!tiles.isEmpty()) grid.setSelection(0);
    }

    @Override public boolean dispatchKeyEvent(KeyEvent e) {
        if (e.getAction() == KeyEvent.ACTION_DOWN && e.getRepeatCount() == 0) {
            int code = e.getKeyCode();
            if (code == SECRET[secretPos]) {
                secretPos++;
                if (secretPos == SECRET.length) {
                    secretPos = 0;
                    startActivity(new Intent(this, AdminLoginActivity.class));
                    return true;
                }
            } else {
                secretPos = code == SECRET[0] ? 1 : 0;
            }
        }
        return super.dispatchKeyEvent(e);
    }

    private void render() {
        // Salida del kiosko: esta pantalla no puede quedar abierta encima del launcher original.
        if (!Config.kiosk(this) && Policy.isOwner(this)) {
            finish();
            return;
        }
        JSONObject cfg = Config.remote(this);
        String title = cfg.optString("title");
        ((TextView) findViewById(R.id.title)).setText(title.isEmpty() ? "WiFly" : title);
        TextClock clock = (TextClock) findViewById(R.id.clock);
        clock.setVisibility(cfg.optBoolean("showClock", true) ? View.VISIBLE : View.GONE);
        renderWallpaper();
        renderNetwork();
        renderWarning();

        boolean blocked = Config.blocked(this) && Config.kiosk(this);
        blockedView.setVisibility(blocked ? View.VISIBLE : View.GONE);
        findViewById(R.id.content).setVisibility(blocked ? View.INVISIBLE : View.VISIBLE);
        if (blocked) {
            String t = cfg.optString("blockTitle");
            String m = cfg.optString("blockMessage");
            ((TextView) findViewById(R.id.blocked_title)).setText(t.isEmpty() ? getString(R.string.blocked_title) : t);
            ((TextView) findViewById(R.id.blocked_body)).setText(m.isEmpty() ? getString(R.string.blocked_body) : m);
            blockedView.requestFocus();
            return;
        }
        loadTiles();
        adapter.notifyDataSetChanged();
        findViewById(R.id.empty).setVisibility(tiles.size() <= 1 ? View.VISIBLE : View.GONE);
        grid.requestFocus();
    }

    private void renderNetwork() {
        String name = MdmService.networkName(this);
        ((TextView) findViewById(R.id.network)).setText(name.isEmpty() ? "Sin conexión" : name);
    }

    private void renderWarning() {
        TextView w = (TextView) findViewById(R.id.warning);
        String text = null;
        if (!Policy.protectedMode(this)) text = getString(R.string.warn_owner);
        else if (Config.usingDefaultCredentials(this)) text = getString(R.string.warn_default);
        w.setText(text);
        w.setVisibility(text == null ? View.GONE : View.VISIBLE);
    }

    /** Reduce la imagen al tamaño de la pantalla: un JPG de 4K sin escalar revienta la memoria de estos equipos. */
    private void renderWallpaper() {
        String sha = Config.p(this).getString("wallpaper_sha", "");
        if (sha.equals(wallpaperLoaded)) return;
        wallpaperLoaded = sha;
        File f = new File(getFilesDir(), "wallpaper");
        Bitmap bmp = null;
        if (!sha.isEmpty() && f.exists()) {
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(f.getPath(), o);
            DisplayMetrics dm = getResources().getDisplayMetrics();
            int sample = 1;
            while (o.outWidth / (sample * 2) >= dm.widthPixels && o.outHeight / (sample * 2) >= dm.heightPixels) sample *= 2;
            o = new BitmapFactory.Options();
            o.inSampleSize = sample;
            o.inPreferredConfig = Bitmap.Config.RGB_565;
            try {
                bmp = BitmapFactory.decodeFile(f.getPath(), o);
            } catch (OutOfMemoryError e) {
                bmp = null;
            }
        }
        if (bmp != null) wallpaper.setImageBitmap(bmp);
        else wallpaper.setImageResource(R.drawable.wallpaper);
    }

    private void loadTiles() {
        tiles.clear();
        PackageManager pm = getPackageManager();
        for (String pkg : Config.allowed(this)) {
            Intent launch = pm.getLeanbackLaunchIntentForPackage(pkg);
            if (launch == null) launch = pm.getLaunchIntentForPackage(pkg);
            if (launch == null) continue;
            Tile t = new Tile();
            t.intent = launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                ApplicationInfo ai = pm.getApplicationInfo(pkg, 0);
                t.label = pm.getApplicationLabel(ai).toString();
                t.image = pm.getApplicationBanner(ai);
                if (t.image == null) t.image = pm.getApplicationIcon(ai);
            } catch (PackageManager.NameNotFoundException e) {
                continue;
            }
            tiles.add(t);
        }
        if (Config.remote(this).optBoolean("allowWifi", true)) {
            Tile w = new Tile();
            w.label = getString(R.string.wifi);
            w.image = getDrawable(R.drawable.wifi);
            w.intent = new Intent(this, WifiActivity.class);
            tiles.add(w);
        }
    }

}
