const $app = document.getElementById('app');
const $toast = document.getElementById('toast');

// ---- Utilidades ---------------------------------------------------------------------------
/** Crea nodos con textContent: los nombres que informan los equipos nunca se interpretan como HTML. */
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    e.append(kid.nodeType ? kid : String(kid));
  }
  return e;
}

async function api(method, url, body) {
  const opts = { method, headers: { 'x-wifly': '1' } };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let r;
  try {
    r = await fetch(url, opts);
  } catch {
    throw new Error('No hay conexión con el servidor');
  }
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && url !== '/api/login') {
    showLogin();
    throw new Error('La sesión venció. Volvé a entrar.');
  }
  if (!r.ok) throw new Error(data.error || `Error ${r.status}`);
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  $toast.textContent = msg;
  $toast.className = `show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $toast.className = ''; }, isError ? 7000 : 3500);
}
const guard = (fn) => async (...a) => {
  try { return await fn(...a); } catch (e) { toast(e.message, true); }
};

const fileUrl = (sha) => `/api/files/${sha}/content`;
const bgImage = (sha) => (sha ? `url("${fileUrl(sha)}")` : '');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function ago(ts) {
  if (!ts) return 'nunca';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'recién';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return `hace ${Math.round(s / 86400)} días`;
}
const dateTime = (ts) => new Date(ts).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
const sizeOf = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.ceil(b / 1024)} KB`);
const lines = (s) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

function dialog(title, body, actions, cls = '') {
  const d = h('dialog', { class: cls }, h('h2', {}, title), body, h('div', { class: 'dialog-actions' }, actions));
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
  return d;
}

function confirmDialog(title, text, label, danger, run) {
  const d = dialog(title, h('p', {}, text), [
    h('button', { onclick: () => d.close() }, 'Cancelar'),
    h('button', { class: danger ? 'danger' : 'primary', onclick: guard(async () => { await run(); d.close(); }) }, label),
  ]);
}

// ---- Ingreso --------------------------------------------------------------------------------
let stopTimer = () => {};
function showLogin() {
  stopTimer();
  document.querySelectorAll('dialog').forEach((d) => d.remove());
  const err = h('p', { class: 'err', hidden: true });
  const user = h('input', { type: 'text', id: 'u', autocomplete: 'username', required: true });
  const pass = h('input', { type: 'password', id: 'p', autocomplete: 'current-password', required: true });
  $app.replaceChildren(h('div', { class: 'login' }, h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/api/login', { username: user.value, password: pass.value });
        start();
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      }
    },
  }, h('div', { class: 'glass' },
    h('div', { class: 'brand' }, h('img', { src: 'icon.svg', alt: '' }), 'WiFly MDM'),
    h('label', { for: 'u' }, 'Usuario'), user,
    h('label', { for: 'p' }, 'Clave'), pass,
    err,
    h('button', { class: 'primary', type: 'submit' }, 'Entrar')))));
  user.focus();
}

// ---- Marco -----------------------------------------------------------------------------------
const VIEWS = [
  ['wall', 'Pantallas', viewWall],
  ['profiles', 'Perfiles', viewProfiles],
  ['library', 'Biblioteca', viewLibrary],
  ['sends', 'Envíos', viewSends],
  ['enroll', 'Alta de equipos', viewEnroll],
  ['account', 'Cuenta', viewAccount],
];
let current = 'wall';
let $main;

function start() {
  const nav = VIEWS.map(([id, label]) => h('button', { 'data-v': id, onclick: () => go(id) }, label));
  $main = h('main', { id: 'main' });
  $app.replaceChildren(h('div', { class: 'shell' },
    h('nav', { class: 'rail', 'aria-label': 'Secciones' },
      h('div', { class: 'brand' }, h('img', { src: 'icon.svg', alt: '' }), 'WiFly MDM'),
      nav,
      h('div', { class: 'bottom' }, h('button', {
        onclick: guard(async () => { await api('POST', '/api/logout', {}); showLogin(); }),
      }, 'Salir'))),
    $main));
  go(location.hash.slice(1) || 'wall');
}

function go(id) {
  if (!VIEWS.some(([v]) => v === id)) id = 'wall';
  current = id;
  stopTimer();
  stopTimer = () => {};
  history.replaceState(null, '', `#${id}`);
  document.querySelectorAll('.rail [data-v]').forEach((b) => {
    if (b.dataset.v === id) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  document.querySelector('.actionbar')?.remove();
  $main.textContent = '';
  guard(VIEWS.find(([v]) => v === id)[2])();
}

const fill = (...kids) => $main.replaceChildren(...kids.flat(Infinity).filter(Boolean));
const header = (title, ...rest) => h('div', { class: 'head' }, h('h1', {}, title), rest);

// ---- Pantallas --------------------------------------------------------------------------------
const selected = new Set();
const filter = { text: '', status: '', group: '' };
let devices = [];
let profilesCache = [];

async function viewWall() {
  profilesCache = await api('GET', '/api/profiles');
  const wallBox = h('div');
  const count = h('span', { class: 'count' });
  const groupSel = h('select', { 'aria-label': 'Grupo', onchange: (e) => { filter.group = e.target.value; paint(); } });
  fill(
    header('Pantallas', count),
    h('div', { class: 'filters' },
      h('input', { type: 'search', placeholder: 'Buscar por nombre, modelo o IP', 'aria-label': 'Buscar', value: filter.text, oninput: (e) => { filter.text = e.target.value.toLowerCase(); paint(); } }),
      h('select', { 'aria-label': 'Estado', onchange: (e) => { filter.status = e.target.value; paint(); } },
        [['', 'Todos los estados'], ['online', 'En línea'], ['offline', 'Sin señal'], ['blocked', 'Bloqueados'], ['alert', 'Con alertas']].map(([v, t]) => h('option', { value: v, selected: filter.status === v }, t))),
      groupSel,
      h('button', { onclick: () => { visible().forEach((d) => selected.add(d.id)); paint(); } }, 'Seleccionar los visibles')),
    wallBox);

  const visible = () => devices.filter((d) => {
    const hay = `${d.name} ${d.state.model || ''} ${d.state.ip || ''} ${d.group}`.toLowerCase();
    if (filter.text && !hay.includes(filter.text)) return false;
    if (filter.group && d.group !== filter.group) return false;
    if (filter.status === 'online' && !d.online) return false;
    if (filter.status === 'offline' && d.online) return false;
    if (filter.status === 'blocked' && !d.blocked) return false;
    if (filter.status === 'alert' && !alertsOf(d).length) return false;
    return true;
  });

  function paint() {
    const focusId = document.activeElement?.dataset?.id;
    for (const id of [...selected]) if (!devices.some((d) => d.id === id)) selected.delete(id);
    const on = devices.filter((d) => d.online).length;
    count.textContent = devices.length ? `${on} de ${plural(devices.length, 'equipo', 'equipos')} en línea` : '';
    const groups = [...new Set(devices.map((d) => d.group))].sort();
    groupSel.replaceChildren(h('option', { value: '' }, 'Todos los grupos'), ...groups.filter(Boolean).map((g) => h('option', { value: g, selected: g === filter.group }, g)));

    if (!devices.length) {
      wallBox.replaceChildren(h('div', { class: 'empty' },
        h('h2', {}, 'Todavía no hay equipos'),
        h('p', {}, 'Creá un token en Alta de equipos y usalo para instalar WiFly Launcher en tu primer TV Box.'),
        h('button', { class: 'primary', onclick: () => go('enroll') }, 'Dar de alta un equipo')));
    } else {
      const list = visible();
      const byGroup = new Map();
      for (const d of list) (byGroup.get(d.group) || byGroup.set(d.group, []).get(d.group)).push(d);
      const showNames = byGroup.size > 1 || (byGroup.size === 1 && !byGroup.has(''));
      wallBox.replaceChildren(...(list.length ? [...byGroup].flatMap(([g, ds]) => [
        showNames ? h('div', { class: 'group-name' }, g || 'Sin grupo') : null,
        h('div', { class: 'wall' }, ds.map(unit)),
      ].filter(Boolean)) : [h('div', { class: 'empty' }, h('p', {}, 'Ningún equipo coincide con el filtro.'))]));
    }
    paintBar();
    if (focusId) document.querySelector(`[data-id="${CSS.escape(focusId)}"]`)?.focus();
  }

  function unit(d) {
    const sel = selected.has(d.id);
    const alerts = alertsOf(d);
    let glass;
    if (d.blocked) {
      glass = h('span', { class: 'glass blocked' }, h('strong', {}, d.blockTitle || 'Bloqueado'), d.blockMessage ? h('span', {}, d.blockMessage) : null);
    } else if (!d.online) {
      glass = h('span', { class: 'glass off' }, 'Sin señal');
    } else {
      glass = h('span', { class: 'glass' }, h('span', { class: 'top' }, h('span', {}, d.title || 'WiFly'), h('span', { class: 'tick' }, sel ? '✓' : '')), h('span', { class: 'state' }, d.state.kiosk === false ? 'Fuera del kiosko' : `${d.effectiveApps.length} apps`));
      if (d.wallpaperSha) glass.style.backgroundImage = bgImage(d.wallpaperSha);
    }
    if (d.blocked || !d.online) {
      if (sel) glass.prepend(h('span', { class: 'tick' }, '✓'));
    }
    return h('div', { class: 'unit' },
      h('button', {
        class: 'screen', 'data-id': d.id, 'aria-pressed': String(sel),
        'aria-label': `Seleccionar ${d.name}`,
        onclick: () => { if (sel) selected.delete(d.id); else selected.add(d.id); paint(); },
      }, glass, h('span', { class: `power${d.online ? ' on' : ''}` })),
      h('div', { class: 'caption' },
        h('div', {},
          h('div', { class: 'name' }, d.name),
          h('div', { class: 'sub' }, d.online ? (d.state.network || 'En línea') : `Visto ${ago(d.lastSeen)}`),
          alerts.length ? h('div', { class: 'alert-line' }, alerts[0]) : null),
        h('button', { class: 'plain', onclick: () => openDevice(d.id, load) }, 'Ver')));
  }

  function paintBar() {
    document.querySelector('.actionbar')?.remove();
    if (!selected.size) return;
    const ids = [...selected];
    $app.append(h('div', { class: 'actionbar', role: 'region', 'aria-label': 'Acciones sobre la selección' },
      h('strong', {}, `${plural(ids.length, 'equipo seleccionado', 'equipos seleccionados')}`),
      h('button', { class: 'primary', onclick: () => sendMessageDialog(ids, load) }, 'Enviar mensaje'),
      h('button', { class: 'stop', onclick: () => lockDialog(ids, load) }, 'Bloquear'),
      h('button', { onclick: guard(() => bulk(ids, 'unlock', {}, 'Desbloqueo enviado', load)) }, 'Desbloquear'),
      h('button', { onclick: () => assignDialog(ids, load) }, 'Cambiar perfil'),
      h('button', { onclick: () => confirmDialog('Reiniciar equipos', `Se van a reiniciar ${plural(ids.length, 'equipo', 'equipos')}. Quien esté mirando algo se va a cortar.`, 'Reiniciar', true, () => bulk(ids, 'reboot', {}, 'Reinicio enviado', load)) }, 'Reiniciar'),
      h('span', { class: 'spacer' }),
      h('button', { onclick: () => { selected.clear(); paint(); } }, 'Quitar selección')));
  }

  async function load() {
    if (current !== 'wall') return;
    devices = await api('GET', '/api/devices');
    if (current === 'wall') paint();
  }
  await load();
  const t = setInterval(() => {
    if (document.querySelector('dialog') || document.activeElement?.tagName === 'SELECT') return;
    load().catch(() => {});
  }, 5000);
  stopTimer = () => clearInterval(t);
}

function alertsOf(d) {
  const s = d.state;
  const a = [];
  if (s.mode === 'compat') a.push('Modo compatible: protección intermedia, instala apps con confirmación en pantalla');
  else if (s.deviceOwner === false) a.push('No es Device Owner: el kiosko no está protegido');
  else if (d.online && s.kiosk === true && s.lockTask === false) a.push('El kiosko no está activo');
  if (s.defaultCredentials && !d.blocked) a.push('Usa la clave de salida por defecto');
  if (d.online && s.keyGuard === false) a.push('Falta la protección de teclas');
  if (d.online && s.adbOpen) a.push('ADB abierto');
  return a;
}

async function bulk(ids, action, payload, okMsg, after) {
  const r = await api('POST', '/api/devices/bulk', { ids, action, payload });
  toast(`${okMsg}: ${plural(r.count, 'equipo', 'equipos')}`);
  if (after) await after();
}

function sendMessageDialog(ids, after) {
  const title = h('input', { type: 'text', id: 'mt', maxlength: 80, placeholder: 'Aviso' });
  const body = h('textarea', { id: 'mb', maxlength: 1000, required: true });
  const mode = h('select', { id: 'mm' }, h('option', { value: 'modal' }, 'Ventana con botón Aceptar'), h('option', { value: 'banner' }, 'Franja abajo, sin interrumpir'));
  const seconds = h('input', { type: 'number', id: 'ms', min: 0, max: 3600, value: 0 });
  const d = dialog(`Enviar mensaje a ${plural(ids.length, 'equipo', 'equipos')}`, h('div', {},
    h('label', { for: 'mt' }, 'Título'), title,
    h('label', { for: 'mb' }, 'Mensaje'), body,
    h('label', { for: 'mm' }, 'Cómo se muestra'), mode,
    h('label', { for: 'ms' }, 'Cerrar solo después de (segundos)'), seconds,
    h('p', { class: 'hint' }, 'Con 0, la ventana queda hasta que el usuario acepta y la franja dura 15 segundos. Los equipos apagados lo reciben al conectarse, durante 7 días.')), [
    h('button', { onclick: () => d.close() }, 'Cancelar'),
    h('button', { class: 'primary', onclick: guard(async () => {
      await bulk(ids, 'message', { title: title.value, body: body.value, mode: mode.value, seconds: Number(seconds.value) }, 'Mensaje enviado', after);
      d.close();
    }) }, 'Enviar mensaje'),
  ]);
  body.focus();
}

function lockDialog(ids, after) {
  const title = h('input', { type: 'text', id: 'lt', maxlength: 80, placeholder: 'Equipo bloqueado' });
  const msg = h('textarea', { id: 'lm', maxlength: 500, placeholder: 'Por ejemplo: comunicate con administración al 11 5555 0000' });
  const d = dialog(`Bloquear ${plural(ids.length, 'equipo', 'equipos')}`, h('div', {},
    h('p', {}, 'Se cierra lo que esté abierto y queda solo esta pantalla, aunque el equipo se reinicie o pierda internet. Los apagados se bloquean al conectarse.'),
    h('label', { for: 'lt' }, 'Título en pantalla'), title,
    h('label', { for: 'lm' }, 'Mensaje en pantalla'), msg), [
    h('button', { onclick: () => d.close() }, 'Cancelar'),
    h('button', { class: 'danger', onclick: guard(async () => {
      await bulk(ids, 'lock', { title: title.value, message: msg.value }, 'Bloqueo enviado', after);
      d.close();
    }) }, 'Bloquear'),
  ]);
}

function assignDialog(ids, after) {
  const sel = h('select', { id: 'ap' }, profilesCache.map((p) => h('option', { value: p.id }, p.name)));
  const d = dialog(`Cambiar perfil de ${plural(ids.length, 'equipo', 'equipos')}`, h('div', {}, h('label', { for: 'ap' }, 'Perfil'), sel), [
    h('button', { onclick: () => d.close() }, 'Cancelar'),
    h('button', { class: 'primary', onclick: guard(async () => {
      await bulk(ids, 'assignProfile', { profileId: Number(sel.value) }, 'Perfil asignado', after);
      d.close();
    }) }, 'Cambiar perfil'),
  ]);
}

// ---- Detalle de un equipo --------------------------------------------------------------------
const STATUS = { pending: ['Esperando al equipo', ''], sent: ['Entregado', ''], done: ['Hecho', 'ok'], failed: ['Falló', 'bad'], expired: ['Venció', 'warn'] };
const COMMAND = { message: 'Mensaje', reboot: 'Reinicio', sync: 'Sincronización', install: 'Instalar app', uninstall: 'Desinstalar app', exitKiosk: 'Salir del kiosko', enterKiosk: 'Activar kiosko', decommission: 'Dar de baja' };
const statusPill = (s) => h('span', { class: `pill ${STATUS[s]?.[1] || ''}` }, STATUS[s]?.[0] || s);

async function openDevice(id, onChange) {
  const [d, files, profiles] = await Promise.all([api('GET', `/api/devices/${id}`), api('GET', '/api/files'), api('GET', '/api/profiles')]);
  const s = d.state;
  const refresh = async () => { dlg.close(); await onChange?.(); await openDevice(id, onChange); };
  const name = h('input', { type: 'text', id: 'dn', value: d.name, maxlength: 80 });
  const group = h('input', { type: 'text', id: 'dg', value: d.group, maxlength: 60 });
  const profile = h('select', { id: 'dp' }, profiles.map((p) => h('option', { value: p.id, selected: p.id === d.profileId }, p.name)));
  const notes = h('textarea', { id: 'dnotes', maxlength: 500, value: d.notes });
  const apk = h('select', { 'aria-label': 'APK para instalar' }, h('option', { value: '' }, 'Elegí un APK'), files.filter((f) => f.kind === 'apk').map((f) => h('option', { value: f.sha }, `${f.name} ${f.versionName}`)));
  const act = (action, payload, msg) => guard(async () => { await bulk([id], action, payload, msg); await refresh(); });

  const setOverride = guard(async (pkg, show) => {
    const inProfile = (profiles.find((p) => p.id === d.profileId)?.apps || []).some((a) => a.package === pkg);
    const add = new Set(d.overrides.add);
    const remove = new Set(d.overrides.remove);
    add.delete(pkg);
    remove.delete(pkg);
    if (show && !inProfile) add.add(pkg);
    if (!show && inProfile) remove.add(pkg);
    await api('PATCH', `/api/devices/${id}`, { overrides: { add: [...add], remove: [...remove] } });
    await refresh();
  });

  const alerts = alertsOf(d);
  const appRows = (s.apps || []).filter((a) => !a.home).map((a) => {
    const shown = d.effectiveApps.includes(a.package);
    return h('tr', {},
      h('td', {}, h('strong', {}, a.label), h('br'), h('small', {}, a.package), a.version ? h('small', {}, ` · ${a.version}`) : null),
      h('td', {}, h('span', { class: `pill ${shown ? 'ok' : ''}` }, shown ? 'Visible' : 'Bloqueada')),
      h('td', {}, h('div', { class: 'row-actions' },
        h('button', { onclick: () => setOverride(a.package, !shown) }, shown ? 'Bloquear' : 'Mostrar'),
        a.system ? null : h('button', { class: 'danger', onclick: () => confirmDialog('Desinstalar app', `¿Desinstalar ${a.label} de ${d.name}?`, 'Desinstalar', true, act('uninstall', { package: a.package }, 'Desinstalación enviada')) }, 'Desinstalar'))));
  });

  const dlg = h('dialog', { class: 'drawer' },
    h('div', { class: 'drawer-head' }, h('h2', {}, d.name), h('button', { onclick: () => dlg.close() }, 'Cerrar')),
    h('p', {}, h('span', { class: `pill ${d.online ? 'ok' : ''}` }, d.online ? 'En línea' : `Sin señal, visto ${ago(d.lastSeen)}`), ' ',
      d.blocked ? h('span', { class: 'pill bad' }, 'Bloqueado') : null, ' ',
      d.synced ? h('span', { class: 'pill ok' }, 'Perfil aplicado') : h('span', { class: 'pill warn' }, 'Perfil pendiente')),
    alerts.map((a) => h('div', { class: 'note' }, a)),
    h('dl', { class: 'facts' },
      [['Modelo', `${s.manufacturer || ''} ${s.model || ''}`], ['Android', s.androidVersion ? `${s.androidVersion} (API ${s.sdk})` : ''],
      ['Launcher', s.launcherVersion || ''], ['Red', s.network || ''], ['IP local', s.ip || ''], ['IP pública', d.publicIp], ['MAC', s.mac || ''],
      ['Kiosko', s.kiosk === false ? 'Desactivado' : s.mode === 'compat' ? 'Activo, modo compatible' : (s.lockTask ? 'Activo' : 'Sin confirmar')]].flatMap(([k, v]) => (v ? [h('dt', {}, k), h('dd', {}, v)] : []))),

    h('h3', {}, 'Acciones'),
    h('div', { class: 'wrap-actions' },
      h('button', { class: 'primary', onclick: () => sendMessageDialog([id], refresh) }, 'Enviar mensaje'),
      d.blocked ? h('button', { onclick: act('unlock', {}, 'Desbloqueo enviado') }, 'Desbloquear') : h('button', { class: 'danger', onclick: () => lockDialog([id], refresh) }, 'Bloquear'),
      h('button', { onclick: act('sync', {}, 'Sincronización enviada') }, 'Sincronizar'),
      h('button', { onclick: () => confirmDialog('Reiniciar equipo', `¿Reiniciar ${d.name}?`, 'Reiniciar', true, act('reboot', {}, 'Reinicio enviado')) }, 'Reiniciar'),
      s.kiosk === false
        ? h('button', { onclick: act('enterKiosk', {}, 'Activación enviada') }, 'Activar kiosko')
        : h('button', { onclick: () => confirmDialog('Salir del kiosko', `${d.name} va a volver al launcher original y queda sin protección hasta reactivar el kiosko.`, 'Salir del kiosko', true, act('exitKiosk', {}, 'Salida enviada')) }, 'Salir del kiosko'),
      h('button', { class: 'danger', onclick: () => confirmDialog('Dar de baja', `WiFly deja de administrar ${d.name} y el equipo vuelve a su estado original. Para administrarlo otra vez hay que reinstalarlo con el script.`, 'Dar de baja', true, act('decommission', {}, 'Baja enviada')) }, 'Dar de baja')),

    h('h3', {}, 'Datos'),
    h('label', { for: 'dn' }, 'Nombre'), name,
    h('label', { for: 'dg' }, 'Grupo'), group,
    h('label', { for: 'dp' }, 'Perfil'), profile,
    h('label', { for: 'dnotes' }, 'Notas'), notes,
    h('div', { class: 'save-bar' }, h('button', { class: 'primary', onclick: guard(async () => {
      await api('PATCH', `/api/devices/${id}`, { name: name.value, group: group.value, profileId: Number(profile.value), notes: notes.value });
      toast('Cambios guardados');
      await refresh();
    }) }, 'Guardar cambios')),

    h('h3', {}, 'Aplicaciones en este equipo'),
    appRows.length
      ? h('div', { class: 'table-wrap' }, h('table', {}, h('tbody', {}, appRows)))
      : h('p', { class: 'hint' }, 'El equipo todavía no informó sus aplicaciones.'),
    h('div', { class: 'inline-add' }, apk, h('button', { onclick: guard(async () => {
      if (!apk.value) throw new Error('Elegí un APK de la lista');
      await bulk([id], 'install', { sha: apk.value }, 'Instalación enviada');
      await refresh();
    }) }, 'Instalar')),

    h('h3', {}, 'Últimos envíos'),
    d.commands.length ? h('div', { class: 'table-wrap' }, h('table', {}, h('tbody', {}, d.commands.map((c) => h('tr', {},
      h('td', {}, COMMAND[c.type] || c.type, c.payload.body ? h('br') : null, c.payload.body ? h('small', {}, c.payload.body) : null),
      h('td', {}, statusPill(c.status), c.detail ? h('br') : null, c.detail ? h('small', {}, c.detail) : null),
      h('td', {}, dateTime(c.createdAt))))))) : h('p', { class: 'hint' }, 'Sin envíos todavía.'),

    h('div', { class: 'save-bar' }, h('button', { class: 'danger', onclick: () => confirmDialog('Eliminar del panel', `Se borra ${d.name} del panel. El equipo conserva su último perfil, sigue en kiosko y deja de recibir órdenes. Si querés liberarlo, usá Dar de baja.`, 'Eliminar del panel', true, guard(async () => {
      await api('DELETE', `/api/devices/${id}`);
      dlg.close();
      await onChange?.();
    })) }, 'Eliminar del panel')));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

// ---- Perfiles ----------------------------------------------------------------------------------
let currentProfile = null;

async function viewProfiles() {
  const [profiles, files, known] = await Promise.all([api('GET', '/api/profiles'), api('GET', '/api/files'), api('GET', '/api/known-apps')]);
  if (!profiles.some((p) => p.id === currentProfile)) currentProfile = profiles[0]?.id ?? null;
  const p = profiles.find((x) => x.id === currentProfile);
  fill(
    header('Perfiles', h('span', { class: 'spacer' }), h('button', { class: 'primary', onclick: newProfile }, 'Crear perfil')),
    h('p', {}, 'Un perfil define qué ve un grupo de TV Boxes: aplicaciones, imagen de fondo y clave de salida.'),
    h('div', { class: 'two' },
      h('div', { class: 'picklist' }, profiles.map((x) => h('button', {
        'aria-current': String(x.id === currentProfile),
        onclick: () => { currentProfile = x.id; go('profiles'); },
      }, x.name, h('small', {}, `${plural(x.deviceCount, 'equipo', 'equipos')}, ${plural(x.apps.length, 'app', 'apps')}`)))),
      p ? profileForm(p, files, known) : h('div', { class: 'sheet' }, 'Creá un perfil para empezar.')));
}

function newProfile() {
  const n = h('input', { type: 'text', id: 'pn', maxlength: 60 });
  const d = dialog('Crear perfil', h('div', {}, h('label', { for: 'pn' }, 'Nombre'), n), [
    h('button', { onclick: () => d.close() }, 'Cancelar'),
    h('button', { class: 'primary', onclick: guard(async () => {
      const r = await api('POST', '/api/profiles', { name: n.value, title: n.value });
      currentProfile = r.id;
      d.close();
      go('profiles');
    }) }, 'Crear perfil'),
  ]);
  n.focus();
}

function profileForm(p, files, known) {
  const apks = files.filter((f) => f.kind === 'apk');
  const images = files.filter((f) => f.kind === 'image');
  let wallpaper = p.wallpaperSha;
  const apps = new Map(p.apps.map((a) => [a.package, { ...a }]));
  const catalog = new Map(known.map((k) => [k.package, k]));
  for (const a of p.apps) if (!catalog.has(a.package)) catalog.set(a.package, { package: a.package, label: a.label || a.package });

  const name = h('input', { type: 'text', id: 'f-name', value: p.name, maxlength: 60 });
  const title = h('input', { type: 'text', id: 'f-title', value: p.title, maxlength: 60, oninput: paintPreview });
  const clock = h('input', { type: 'checkbox', checked: p.showClock !== false, onchange: paintPreview });
  const wifi = h('input', { type: 'checkbox', checked: p.allowWifi !== false, onchange: paintPreview });
  const adb = h('input', { type: 'checkbox', checked: !!p.adbAllowed });
  const exitUser = h('input', { type: 'text', id: 'f-eu', value: p.exitUser, maxlength: 40, autocomplete: 'off' });
  const exitPass = h('input', { type: 'password', id: 'f-ep', autocomplete: 'new-password', placeholder: p.hasExit ? 'Dejala vacía para no cambiarla' : '' });
  const remove = h('textarea', { id: 'f-rem', value: p.removePackages.join('\n') });
  const helpers = h('textarea', { id: 'f-hel', value: p.helpers.join('\n') });
  const launcher = h('select', { id: 'f-la' }, h('option', { value: '' }, 'No actualizar'), apks.filter((f) => f.package === 'com.wifly.launcher').map((f) => h('option', { value: f.sha, selected: f.sha === p.launcherApkSha }, `Versión ${f.versionName} (${f.versionCode})`)));

  const glass = h('div', { class: 'glass' });
  const wpSel = h('select', { 'aria-label': 'Imagen de fondo', onchange: (e) => { wallpaper = e.target.value; paintPreview(); } }, h('option', { value: '' }, 'Imagen de WiFly'), images.map((f) => h('option', { value: f.sha, selected: f.sha === wallpaper }, f.name)));
  function paintPreview() {
    glass.style.backgroundImage = bgImage(wallpaper);
    const names = [...apps.values()].map((a) => a.label || catalog.get(a.package)?.label || a.package);
    if (wifi.checked) names.push('WiFi');
    glass.replaceChildren(
      h('div', { class: 'bar' }, h('span', {}, title.value || 'WiFly'), clock.checked ? h('span', {}, '21:30') : null),
      h('div', { class: 'tiles' }, names.slice(0, 8).map((n, i) => h('div', { class: `tile${i === 0 ? ' first' : ''}` }, n))));
  }

  const upWall = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', 'aria-label': 'Subir imagen', onchange: guard(async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const fd = new FormData();
    fd.set('kind', 'image');
    fd.set('file', f);
    toast('Subiendo imagen…');
    const r = await api('POST', '/api/files', fd);
    wallpaper = r.sha;
    if (![...wpSel.options].some((o) => o.value === r.sha)) wpSel.append(h('option', { value: r.sha }, r.name));
    wpSel.value = r.sha;
    paintPreview();
    toast('Imagen lista. Guardá el perfil para aplicarla.');
  }) });

  const appBox = h('div');
  function paintApps() {
    appBox.replaceChildren(...[...catalog.values()].map((k) => {
      const on = apps.has(k.package);
      const options = apks.filter((f) => f.package === k.package);
      return h('div', { class: 'app-row' },
        h('input', { type: 'checkbox', checked: on, 'aria-label': `Mostrar ${k.label}`, onchange: (e) => {
          if (e.target.checked) apps.set(k.package, { package: k.package, label: k.label, apkSha: options[0]?.sha || '' });
          else apps.delete(k.package);
          paintApps();
          paintPreview();
        } }),
        h('div', {}, k.label, h('small', {}, k.package)),
        options.length ? h('select', { 'aria-label': `Instalar ${k.label}`, disabled: !on, onchange: (e) => { apps.get(k.package).apkSha = e.target.value; } },
          h('option', { value: '' }, 'Ya instalada'), options.map((f) => h('option', { value: f.sha, selected: apps.get(k.package)?.apkSha === f.sha }, `Instalar ${f.versionName}`))) : h('span'));
    }));
    if (!catalog.size) appBox.append(h('p', { class: 'hint' }, 'Aparecen cuando un equipo informa sus apps o cuando subís un APK a la Biblioteca. También podés agregar un paquete acá abajo.'));
  }
  const manual = h('input', { type: 'text', placeholder: 'com.netflix.ninja', 'aria-label': 'Paquete de Android' });

  paintApps();
  paintPreview();

  const save = guard(async () => {
    await api('PUT', `/api/profiles/${p.id}`, {
      name: name.value, title: title.value, showClock: clock.checked, allowWifi: wifi.checked, adbAllowed: adb.checked,
      wallpaperSha: wallpaper, launcherApkSha: launcher.value, apps: [...apps.values()],
      removePackages: lines(remove.value), helpers: lines(helpers.value),
      exitUser: exitUser.value, exitPassword: exitPass.value,
    });
    toast(`Perfil guardado. Se aplica en ${plural(p.deviceCount, 'equipo', 'equipos')}.`);
    go('profiles');
  });

  return h('div', {},
    h('div', { class: 'sheet' },
      h('h2', {}, 'Pantalla del TV Box'),
      h('div', { class: 'preview' }, glass),
      h('label', {}, 'Imagen de fondo'), wpSel,
      h('div', { class: 'upload-row' }, upWall),
      h('p', { class: 'hint' }, 'JPG, PNG o WebP, idealmente de 1920 × 1080.'),
      h('label', { for: 'f-name' }, 'Nombre del perfil'), name,
      h('label', { for: 'f-title' }, 'Título en pantalla'), title,
      h('label', { class: 'check' }, clock, 'Mostrar el reloj'),
      h('label', { class: 'check' }, wifi, 'Mostrar el acceso a WiFi')),
    h('div', { class: 'sheet' },
      h('h2', {}, 'Aplicaciones permitidas'),
      h('p', {}, 'Solo estas se ven y se pueden abrir. Todo lo demás queda bloqueado. Las cuentas de cada app las ingresa el usuario dentro de la app.'),
      appBox,
      h('div', { class: 'inline-add' }, manual, h('button', { onclick: () => {
        const pkg = manual.value.trim();
        if (!/^[A-Za-z][\w]*(\.\w+)+$/.test(pkg)) return toast('Escribí un paquete de Android, como com.netflix.ninja', true);
        catalog.set(pkg, catalog.get(pkg) || { package: pkg, label: pkg });
        apps.set(pkg, { package: pkg, label: catalog.get(pkg).label, apkSha: '' });
        manual.value = '';
        paintApps();
        paintPreview();
      } }, 'Agregar paquete'))),
    h('div', { class: 'sheet' },
      h('h2', {}, 'Salida del kiosko'),
      p.hasExit ? null : h('div', { class: 'note bad' }, 'Este perfil no define clave. Los equipos conservan la que tengan cargada.'),
      h('p', {}, 'En el TV Box, con el control: arriba, arriba, abajo, abajo, izquierda, derecha, izquierda, derecha. Después piden este usuario y clave.'),
      h('label', { for: 'f-eu' }, 'Usuario'), exitUser,
      h('label', { for: 'f-ep' }, 'Clave'), exitPass),
    h('div', { class: 'sheet' },
      h('h2', {}, 'Opciones avanzadas'),
      h('label', { for: 'f-la' }, 'Actualizar WiFly Launcher'), launcher,
      h('label', { for: 'f-rem' }, 'Desinstalar estos paquetes'), remove,
      h('p', { class: 'hint' }, 'Uno por línea. Solo se quitan apps que Android permita desinstalar.'),
      h('label', { for: 'f-hel' }, 'Paquetes auxiliares'), helpers,
      h('p', { class: 'hint' }, 'Sin ícono, pero pueden abrirse desde otra app. Agregá acá lo que necesite una app para iniciar sesión si no llega a abrir esa pantalla.'),
      h('label', { class: 'check' }, adb, 'Dejar ADB abierto. Solo para pruebas: con ADB se puede salir del kiosko sin clave.')),
    h('div', { class: 'save-bar' },
      h('button', { class: 'primary', onclick: save }, 'Guardar perfil'),
      h('button', { class: 'danger', onclick: () => confirmDialog('Eliminar perfil', `¿Eliminar ${p.name}?`, 'Eliminar perfil', true, guard(async () => { await api('DELETE', `/api/profiles/${p.id}`); currentProfile = null; go('profiles'); })) }, 'Eliminar perfil')));
}

// ---- Biblioteca ----------------------------------------------------------------------------------
async function viewLibrary() {
  const files = await api('GET', '/api/files');
  const input = h('input', { type: 'file', accept: '.apk,.apks,.xapk,.apkm', 'aria-label': 'Elegir app', onchange: guard(async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const fd = new FormData();
    fd.set('kind', 'apk');
    fd.set('file', f);
    toast(`Subiendo ${f.name}…`);
    const r = await api('POST', '/api/files', fd);
    toast(r.warning || `${r.name} ${r.versionName} ya está en la biblioteca`, !!r.warning);
    go('library');
  }) });
  const del = (f) => confirmDialog('Eliminar archivo', `¿Eliminar ${f.name}?`, 'Eliminar', true, guard(async () => { await api('DELETE', `/api/files/${f.sha}`); go('library'); }));
  const apks = files.filter((f) => f.kind === 'apk');
  const images = files.filter((f) => f.kind === 'image');
  fill(
    header('Biblioteca'),
    h('p', {}, 'Subí las apps que quieras instalar sin tocar los equipos. Después elegilas en un perfil o desde el detalle de un equipo.'),
    h('div', { class: 'sheet' }, h('h2', {}, 'Subir una app'), input,
      h('p', { class: 'hint' }, 'APK común o app dividida (.apks, .xapk o .apkm). De una app dividida, cada TV Box instala solo las partes de su arquitectura.')),
    h('div', { class: 'sheet' }, h('h2', {}, 'Aplicaciones'),
      apks.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Nombre', 'Paquete', 'Versión', 'Formato', 'Tamaño', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, apks.map((f) => h('tr', {}, h('td', {}, f.name), h('td', {}, f.package), h('td', {}, `${f.versionName} (${f.versionCode})`), h('td', {}, f.parts ? `Dividida, ${f.parts} partes` : 'APK'), h('td', {}, sizeOf(f.size)), h('td', {}, h('button', { class: 'plain', onclick: () => del(f) }, 'Eliminar')))))))
        : h('p', { class: 'hint' }, 'Todavía no subiste ninguna app.')),
    images.length ? h('div', { class: 'sheet' }, h('h2', {}, 'Imágenes de fondo'), h('div', { class: 'table-wrap' }, h('table', {}, h('tbody', {}, images.map((f) => h('tr', {}, h('td', {}, f.name), h('td', {}, sizeOf(f.size)), h('td', {}, h('button', { class: 'plain', onclick: () => del(f) }, 'Eliminar')))))))) : null);
}

// ---- Envíos ----------------------------------------------------------------------------------------
async function viewSends() {
  const [sends, audit] = await Promise.all([api('GET', '/api/sends'), api('GET', '/api/audit')]);
  fill(
    header('Envíos'),
    h('div', { class: 'sheet' }, h('h2', {}, 'Mensajes y órdenes'),
      sends.length ? sends.map((s) => h('div', {},
        h('h3', {}, COMMAND[s.type] || s.type, ', ', dateTime(s.createdAt)),
        s.payload.body ? h('p', {}, s.payload.title ? `${s.payload.title}: ` : '', s.payload.body) : null,
        h('div', { class: 'table-wrap' }, h('table', {}, h('tbody', {}, s.items.map((i) => h('tr', {}, h('td', {}, i.device), h('td', {}, statusPill(i.status)), h('td', {}, i.detail))))))))
        : h('p', { class: 'hint' }, 'Los mensajes y órdenes que envíes aparecen acá con su estado por equipo.')),
    h('div', { class: 'sheet' }, h('h2', {}, 'Actividad del panel'),
      h('div', { class: 'table-wrap' }, h('table', {}, h('tbody', {}, audit.map((a) => h('tr', {}, h('td', {}, dateTime(a.ts)), h('td', {}, a.actor), h('td', {}, a.action), h('td', {}, a.detail))))))));
}

// ---- Alta de equipos ---------------------------------------------------------------------------------
async function viewEnroll() {
  const [tokens, profiles] = await Promise.all([api('GET', '/api/enroll-tokens'), api('GET', '/api/profiles')]);
  const label = h('input', { type: 'text', id: 't-l', maxlength: 80, placeholder: 'Lote hotel, noviembre' });
  const profile = h('select', { id: 't-p' }, profiles.map((p) => h('option', { value: p.id }, p.name)));
  const group = h('input', { type: 'text', id: 't-g', maxlength: 60 });
  const maxUses = h('input', { type: 'number', id: 't-m', min: 0, value: 0 });
  const days = h('input', { type: 'number', id: 't-d', min: 0, value: 30 });
  const origin = location.origin;
  fill(
    header('Alta de equipos'),
    origin.startsWith('https://') ? null : h('div', { class: 'note bad' }, 'Estás usando el panel sin HTTPS. Sirve para probar en tu red local, pero para equipos reales configurá HTTPS: sin él, alguien en la red podría ver las claves o enviar órdenes a los equipos.'),
    h('div', { class: 'sheet' }, h('h2', {}, 'Crear token'),
      h('p', {}, 'El token asigna a cada equipo nuevo un perfil y un grupo.'),
      h('label', { for: 't-l' }, 'Nombre'), label,
      h('label', { for: 't-p' }, 'Perfil'), profile,
      h('label', { for: 't-g' }, 'Grupo'), group,
      h('label', { for: 't-m' }, 'Máximo de equipos (0 = sin límite)'), maxUses,
      h('label', { for: 't-d' }, 'Días de validez (0 = no vence)'), days,
      h('div', { class: 'save-bar' }, h('button', { class: 'primary', onclick: guard(async () => {
        await api('POST', '/api/enroll-tokens', { label: label.value, profileId: Number(profile.value), group: group.value, maxUses: Number(maxUses.value), days: Number(days.value) });
        go('enroll');
      }) }, 'Crear token'))),
    tokens.map((t) => {
      const expired = t.expiresAt && t.expiresAt < Date.now();
      const full = t.maxUses && t.uses >= t.maxUses;
      return h('div', { class: 'sheet' },
        h('h2', {}, t.label || 'Token sin nombre', ' ', expired ? h('span', { class: 'pill bad' }, 'Vencido') : full ? h('span', { class: 'pill warn' }, 'Agotado') : h('span', { class: 'pill ok' }, 'Activo')),
        h('p', {}, `Perfil ${profiles.find((p) => p.id === t.profileId)?.name || 'sin asignar'}${t.group ? `, grupo ${t.group}` : ''}. Usado ${t.uses}${t.maxUses ? ` de ${t.maxUses}` : ''} veces${t.expiresAt ? `. Vence ${dateTime(t.expiresAt)}` : ''}.`),
        h('p', {}, 'Con el TV Box conectado por ADB, corré desde la carpeta de instalación:'),
        h('pre', {}, `./enroll.sh --server ${origin} --token ${t.token}`),
        h('p', { class: 'hint' }, 'En Windows: ', h('code', {}, `enroll.bat ${origin} ${t.token}`)),
        h('button', { class: 'plain', onclick: () => confirmDialog('Revocar token', 'Los equipos ya registrados siguen funcionando. No se van a poder sumar equipos nuevos con este token.', 'Revocar token', true, guard(async () => { await api('DELETE', `/api/enroll-tokens/${t.token}`); go('enroll'); })) }, 'Revocar token'));
    }));
}

// ---- Cuenta -----------------------------------------------------------------------------------------
async function viewAccount() {
  const me = await api('GET', '/api/me');
  const cur = h('input', { type: 'password', id: 'c-c', autocomplete: 'current-password' });
  const nxt = h('input', { type: 'password', id: 'c-n', autocomplete: 'new-password' });
  fill(
    header('Cuenta'),
    h('div', { class: 'sheet' }, h('p', {}, 'Entraste como ', h('strong', {}, me.username), '.'),
      h('h2', {}, 'Cambiar clave del panel'),
      h('label', { for: 'c-c' }, 'Clave actual'), cur,
      h('label', { for: 'c-n' }, 'Clave nueva (10 caracteres o más)'), nxt,
      h('div', { class: 'save-bar' }, h('button', { class: 'primary', onclick: guard(async () => {
        await api('POST', '/api/password', { current: cur.value, next: nxt.value });
        cur.value = '';
        nxt.value = '';
        toast('Clave cambiada');
      }) }, 'Cambiar clave'))));
}

// ---- Arranque --------------------------------------------------------------------------------------
api('GET', '/api/me').then(start).catch(() => {});
