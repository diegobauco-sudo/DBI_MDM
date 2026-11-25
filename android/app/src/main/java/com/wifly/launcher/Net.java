package com.wifly.launcher;

import android.content.Context;
import android.os.Build;

import org.json.JSONObject;

import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

final class Net {
    static final class HttpError extends IOException {
        final int code;
        HttpError(int code, String m) { super("HTTP " + code + " " + m); this.code = code; }
    }

    private Net() {}

    private static HttpURLConnection open(String url, String method, String token, int timeoutMs) throws IOException {
        HttpURLConnection h = (HttpURLConnection) new URL(url).openConnection();
        h.setRequestMethod(method);
        h.setConnectTimeout(15000);
        h.setReadTimeout(timeoutMs);
        h.setRequestProperty("Accept", "application/json");
        if (token != null && !token.isEmpty()) h.setRequestProperty("Authorization", "Bearer " + token);
        return h;
    }

    private static String read(InputStream in) throws IOException {
        if (in == null) return "";
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
        in.close();
        return b.toString("UTF-8");
    }

    static JSONObject json(String base, String token, String method, String path, JSONObject body, int timeoutMs) throws Exception {
        HttpURLConnection h = open(trim(base) + path, method, token, timeoutMs);
        try {
            if (body != null) {
                h.setDoOutput(true);
                h.setRequestProperty("Content-Type", "application/json");
                OutputStream o = h.getOutputStream();
                o.write(body.toString().getBytes("UTF-8"));
                o.close();
            }
            int code = h.getResponseCode();
            String text = read(code < 400 ? h.getInputStream() : h.getErrorStream());
            if (code >= 400) throw new HttpError(code, text.length() > 200 ? text.substring(0, 200) : text);
            return text.isEmpty() ? new JSONObject() : new JSONObject(text);
        } finally {
            h.disconnect();
        }
    }

    private static String trim(String s) { return s.endsWith("/") ? s.substring(0, s.length() - 1) : s; }

    /** Descarga y verifica SHA-256 antes de aceptar el archivo. */
    static void download(Context c, String path, String sha, File dest) throws Exception {
        File tmp = new File(dest.getParentFile(), dest.getName() + ".part");
        HttpURLConnection h = open(trim(Config.server(c)) + path, "GET", Config.deviceToken(c), 60000);
        try {
            int code = h.getResponseCode();
            if (code != 200) throw new HttpError(code, "descarga");
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            InputStream in = h.getInputStream();
            OutputStream out = new BufferedOutputStream(new FileOutputStream(tmp));
            try {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) {
                    md.update(buf, 0, n);
                    out.write(buf, 0, n);
                }
            } finally {
                out.close();
                in.close();
            }
            if (!Crypto.hex(md.digest()).equalsIgnoreCase(sha)) {
                tmp.delete();
                throw new IOException("El archivo descargado no coincide con su SHA-256");
            }
            if (dest.exists()) dest.delete();
            if (!tmp.renameTo(dest)) throw new IOException("No se pudo guardar " + dest.getName());
        } finally {
            h.disconnect();
        }
    }

    /** Registra el equipo en el servidor. Lanza una excepción si el token no sirve. */
    static void enroll(Context c, String server, String token) throws Exception {
        JSONObject b = new JSONObject();
        b.put("token", token);
        b.put("installId", Config.installId(c));
        b.put("model", Build.MODEL);
        b.put("manufacturer", Build.MANUFACTURER);
        b.put("androidVersion", Build.VERSION.RELEASE);
        b.put("sdk", Build.VERSION.SDK_INT);
        JSONObject r = json(server, null, "POST", "/api/device/enroll", b, 30000);
        Config.p(c).edit()
            .putString("server", trim(server))
            .putString("device_token", r.getString("deviceToken"))
            .apply();
    }
}
