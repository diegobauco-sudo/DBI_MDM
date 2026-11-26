/**
 * Validaciones de datos que carga el panel: claves, documentos argentinos, email y teléfono.
 * Cada función devuelve el valor limpio o lanza un Error con un mensaje para mostrar tal cual.
 */

export const PASSWORD_MIN = 10;
export const PASSWORD_RULE = `La clave necesita ${PASSWORD_MIN} caracteres o más, con al menos una mayúscula, una minúscula, un número y un carácter especial`;

/** Qué le falta a una clave para cumplir la política. Vacío = cumple. */
export function passwordProblems(p) {
  const s = typeof p === 'string' ? p : '';
  const missing = [];
  if (s.length < PASSWORD_MIN) missing.push(`${PASSWORD_MIN} caracteres`);
  if (!/[A-ZÁÉÍÓÚÑ]/.test(s)) missing.push('una mayúscula');
  if (!/[a-záéíóúñ]/.test(s)) missing.push('una minúscula');
  if (!/[0-9]/.test(s)) missing.push('un número');
  if (!/[^A-Za-z0-9ÁÉÍÓÚÑáéíóúñ]/.test(s)) missing.push('un carácter especial');
  return missing;
}

export function checkPassword(p) {
  const missing = passwordProblems(p);
  if (missing.length) throw new Error(`${PASSWORD_RULE}. Le falta: ${missing.join(', ')}.`);
  return p;
}

/** Dígito verificador de CUIT/CUIL (módulo 11). */
export function validCuit(digits) {
  if (!/^\d{11}$/.test(digits)) return false;
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = w.reduce((t, x, i) => t + x * Number(digits[i]), 0);
  let dv = 11 - (sum % 11);
  if (dv === 11) dv = 0;
  if (dv === 10) return false;
  return dv === Number(digits[10]);
}

/**
 * DNI (7 u 8 dígitos) o CUIT/CUIL (11 dígitos con verificador). Acepta puntos, guiones y espacios.
 * Devuelve el número con formato: 12.345.678 o 20-12345678-3.
 */
export function cleanTaxId(v, { required = false, cuitOnly = false } = {}) {
  const raw = String(v ?? '').trim();
  if (!raw) {
    if (required) throw new Error(cuitOnly ? 'Poné el CUIT' : 'Poné el DNI, CUIT o CUIL');
    return '';
  }
  const d = raw.replace(/[\s.-]/g, '');
  if (!/^\d+$/.test(d)) throw new Error('El DNI, CUIT o CUIL lleva solo números (puede tener puntos o guiones)');
  if (d.length === 11) {
    if (!validCuit(d)) throw new Error(`El CUIT/CUIL ${raw} no es válido: revisá el número, el dígito verificador no coincide`);
    return `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}`;
  }
  if (cuitOnly) throw new Error('Para monotributistas y responsables inscriptos va el CUIT, de 11 dígitos');
  if (d.length === 7 || d.length === 8) return Number(d).toLocaleString('es-AR');
  throw new Error('El DNI tiene 7 u 8 dígitos y el CUIT/CUIL, 11');
}

export function cleanEmail(v, { required = false } = {}) {
  const s = String(v ?? '').trim();
  if (!s) {
    if (required) throw new Error('Poné el email');
    return '';
  }
  if (s.length > 120 || !/^[^\s@<>,;"]+@[^\s@<>,;"]+\.[A-Za-z]{2,}$/.test(s)) throw new Error(`El email ${s} no es válido`);
  return s.toLowerCase();
}

export function cleanPhone(v, { required = false } = {}) {
  const s = String(v ?? '').trim();
  if (!s) {
    if (required) throw new Error('Poné el teléfono');
    return '';
  }
  if (!/^[0-9+()\s.-]{6,30}$/.test(s) || (s.match(/\d/g) || []).length < 6) throw new Error(`El teléfono ${s} no es válido: usá números, espacios, +, guiones o paréntesis`);
  return s;
}

export function cleanText(v, max, { required = false, label = 'este dato' } = {}) {
  const s = String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
  if (required && !s) throw new Error(`Completá ${label}`);
  return s;
}

export const TAX_CONDITIONS = { cf: 'Consumidor final', mono: 'Monotributista', ri: 'Responsable inscripto' };
