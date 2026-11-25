package com.wifly.launcher;

import android.app.Application;
import android.os.Handler;
import android.os.Looper;

import java.util.Set;
import java.util.concurrent.CopyOnWriteArraySet;

public class App extends Application {
    private static final Set<Runnable> LISTENERS = new CopyOnWriteArraySet<Runnable>();
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    @Override public void onCreate() {
        super.onCreate();
        Compat.startService(this);
    }

    static void listen(Runnable r) { LISTENERS.add(r); }
    static void unlisten(Runnable r) { LISTENERS.remove(r); }

    /** Avisa a las pantallas abiertas que cambió la configuración. */
    static void changed() {
        MAIN.post(new Runnable() { @Override public void run() {
            for (Runnable r : LISTENERS) r.run();
        }});
    }
}
