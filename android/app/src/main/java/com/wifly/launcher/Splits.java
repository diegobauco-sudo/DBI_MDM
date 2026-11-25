package com.wifly.launcher;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Elige qué partes de una app dividida instalar en este equipo.
 * Se instalan la base, las partes de función, todas las de idioma y densidad (no molestan)
 * y solo las de la mejor arquitectura que soporte el equipo: una de otra arquitectura hace fallar la instalación.
 * Sin dependencias de Android para poder probarla en la PC.
 */
final class Splits {
    private static final Set<String> ABIS = new HashSet<String>(Arrays.asList(
        "armeabi", "armeabi_v7a", "arm64_v8a", "x86", "x86_64", "mips", "mips64"));

    private Splits() {}

    /** "config.arm64_v8a" o "funcion.config.arm64_v8a" devuelve "arm64_v8a"; cualquier otra parte, null. */
    static String abiOf(String split) {
        if (split == null) return null;
        int i = split.lastIndexOf("config.");
        if (i < 0) return null;
        String tail = split.substring(i + 7);
        return ABIS.contains(tail) ? tail : null;
    }

    /**
     * @param splits nombre de cada parte ("" para la base)
     * @param deviceAbis Build.SUPPORTED_ABIS, de la preferida a la menos preferida
     * @return índices de las partes a instalar
     * @throws IllegalStateException si la app no trae ninguna arquitectura que el equipo soporte
     */
    static List<Integer> select(String[] splits, String[] deviceAbis) {
        Set<String> present = new HashSet<String>();
        for (String s : splits) {
            String a = abiOf(s);
            if (a != null) present.add(a);
        }
        String best = null;
        if (!present.isEmpty()) {
            for (String a : deviceAbis) {
                String norm = a.replace('-', '_');
                if (present.contains(norm)) {
                    best = norm;
                    break;
                }
            }
            if (best == null) {
                throw new IllegalStateException("La app no trae versión para este equipo (" + Arrays.toString(deviceAbis)
                    + "); trae " + present + ". Descargá el paquete para esta arquitectura.");
            }
        }
        List<Integer> out = new ArrayList<Integer>();
        for (int i = 0; i < splits.length; i++) {
            String a = abiOf(splits[i]);
            if (a == null || a.equals(best)) out.add(i);
        }
        return out;
    }
}
