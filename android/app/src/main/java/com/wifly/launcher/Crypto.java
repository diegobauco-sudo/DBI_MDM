package com.wifly.launcher;

import java.security.MessageDigest;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** PBKDF2-HMAC-SHA256 propio: SecretKeyFactory recién lo trae desde Android 8. */
final class Crypto {
    private Crypto() {}

    static byte[] pbkdf2(String password, byte[] salt, int iterations) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        byte[] key = password.getBytes("UTF-8");
        // Mac rechaza claves vacías.
        mac.init(new SecretKeySpec(key.length == 0 ? new byte[1] : key, "HmacSHA256"));
        mac.update(salt);
        mac.update(new byte[]{0, 0, 0, 1});
        byte[] u = mac.doFinal();
        byte[] out = u.clone();
        for (int i = 1; i < iterations; i++) {
            u = mac.doFinal(u);
            for (int j = 0; j < out.length; j++) out[j] ^= u[j];
        }
        return out;
    }

    static String hex(byte[] b) {
        StringBuilder s = new StringBuilder(b.length * 2);
        for (byte x : b) s.append(String.format("%02x", x & 0xff));
        return s.toString();
    }

    static byte[] unhex(String s) {
        byte[] b = new byte[s.length() / 2];
        for (int i = 0; i < b.length; i++) b[i] = (byte) Integer.parseInt(s.substring(2 * i, 2 * i + 2), 16);
        return b;
    }

    /** Compara sin cortar en el primer byte distinto. */
    static boolean same(byte[] a, byte[] b) { return MessageDigest.isEqual(a, b); }
}
