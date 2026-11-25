import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const VERSION_RE = /^v\d+\.\d+\.\d+$/;

/**
 * Puente con el actualizador del CT. El contenedor no puede actualizarse solo (no tiene acceso a Docker),
 * así que deja un pedido en request.json; un servicio de systemd en el CT lo toma, actualiza y escribe status.json.
 * updater.json lo crea activar-actualizaciones.sh: si no existe, las actualizaciones no están activadas.
 */
export function createUpdates({ dir, version, now }) {
  const file = (name) => path.join(dir, name);
  const readJson = (name) => {
    try {
      return JSON.parse(fs.readFileSync(file(name), 'utf8'));
    } catch {
      return null;
    }
  };

  function status() {
    const setup = readJson('updater.json');
    const st = readJson('status.json') || {};
    const pending = readJson('request.json');
    return {
      current: `v${version}`,
      enabled: !!setup,
      repo: setup?.repo || '',
      state: pending ? 'pending' : st.state || 'idle',
      pendingAction: pending?.action || '',
      available: Array.isArray(st.available) ? st.available.filter((v) => VERSION_RE.test(v)) : [],
      lastCheck: st.lastCheck || null,
      message: st.message || '',
      log: Array.isArray(st.log) ? st.log.slice(-60) : [],
      target: st.target || '',
      finishedAt: st.finishedAt || null,
    };
  }

  function request(action, target) {
    const s = status();
    if (!s.enabled) throw Object.assign(new Error('Las actualizaciones no están activadas en este servidor. Seguí la guía para activarlas.'), { status: 409 });
    if (s.state === 'pending' || s.state === 'updating' || s.state === 'checking') throw Object.assign(new Error('Ya hay una tarea de actualización en curso'), { status: 409 });
    if (action === 'update') {
      if (!VERSION_RE.test(target || '')) throw Object.assign(new Error('Versión inválida'), { status: 400 });
      if (!s.available.includes(target)) throw Object.assign(new Error('Esa versión no está disponible. Buscá actualizaciones de nuevo.'), { status: 400 });
    }
    const body = JSON.stringify({ id: crypto.randomUUID(), action, version: action === 'update' ? target : '', requestedAt: now() });
    const tmp = file(`.request-${process.pid}.tmp`);
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file('request.json'));
    return status();
  }

  return { status, request };
}
