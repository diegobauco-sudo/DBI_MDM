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
  if (data.code === 'suspended' && url !== '/api/login') {
    showLogin(data.error);
    throw new Error(data.error);
  }
  if (data.code === 'no_company') {
    go('companies');
    throw new Error(data.error);
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
function showLogin(message) {
  stopTimer();
  document.querySelector('.actionbar')?.remove();
  document.querySelectorAll('dialog').forEach((d) => d.remove());
  const err = h('p', { class: 'err', hidden: !message }, message || '');
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
// Cada vista dice quién la ve: g = administrador general sin empresa elegida, a = administrador de empresa,
// o = operador. El administrador general que eligió una empresa ve las vistas de empresa además de las suyas.
const VIEWS = [
  ['companies', 'Empresas', viewCompanies, 'g'],
  ['billing', 'Facturación', viewBilling, 'g'],
  ['settings', 'Configuración', viewSettings, 'g'],
  ['wall', 'Pantallas', viewWall, 'ao'],
  ['profiles', 'Perfiles', viewProfiles, 'a'],
  ['library', 'Biblioteca', viewLibrary, 'a'],
  ['sends', 'Envíos', viewSends, 'ao'],
  ['enroll', 'Alta de equipos', viewEnroll, 'a'],
  ['users', 'Usuarios', viewUsers, 'a'],
  ['account', 'Cuenta', viewAccount, 'gao'],
];
let current = 'wall';
let $main;
let me = null;

const isSuper = () => me?.role === 'superadmin';
const isOperator = () => me?.role === 'operator';
const canAdmin = () => isSuper() || me?.role === 'admin';
function allowed(who) {
  if (isSuper()) return who.includes('g') || (!!me.company && (who.includes('a') || who.includes('o')));
  return who.includes(isOperator() ? 'o' : 'a');
}

/** Nombre de la empresa con la frase fija más chica, como en la pantalla del TV Box. */
function brandBlock(name, phrase) {
  return h('div', { class: 'brand' }, h('img', { src: 'icon.svg', alt: '' }),
    h('span', { class: 'brand-text' }, h('span', { class: 'brand-name' }, name), phrase ? h('span', { class: 'brand-phrase' }, phrase) : null));
}

async function start() {
  me = await api('GET', '/api/me');
  const views = VIEWS.filter(([, , , who]) => allowed(who));
  const globalViews = views.filter(([, , , who]) => who.includes('g') && who !== 'gao');
  const companyViews = views.filter(([, , , who]) => !who.includes('g'));
  const navButton = ([id, label]) => h('button', { 'data-v': id, onclick: () => go(id) }, label);
  $main = h('main', { id: 'main' });
  const brand = me.company && !isSuper() ? brandBlock(me.company.name, me.brandPhrase) : brandBlock(me.product);
  $app.replaceChildren(h('div', { class: 'shell' },
    h('nav', { class: 'rail', 'aria-label': 'Secciones' },
      brand,
      globalViews.map(navButton),
      isSuper() && me.company ? h('div', { class: 'rail-company' },
        h('span', { class: 'rail-label' }, 'Administrando'),
        h('strong', {}, me.company.name),
        h('button', { class: 'rail-back', onclick: guard(() => setContext(null)) }, 'Volver a empresas')) : null,
      companyViews.map(navButton),
      h('div', { class: 'bottom' },
        navButton(['account', 'Cuenta']),
        h('button', { onclick: guard(async () => { await api('POST', '/api/logout', {}); showLogin(); }) }, 'Salir'))),
    $main));
  const first = isSuper() && !me.company ? 'companies' : 'wall';
  go(location.hash.slice(1) || first);
}

async function setContext(companyId) {
  await api('POST', '/api/context', { companyId });
  location.hash = companyId ? 'wall' : 'companies';
  await start();
}

function go(id) {
  const view = VIEWS.find(([v, , , who]) => v === id && allowed(who)) || VIEWS.find(([v, , , who]) => allowed(who) && v !== 'account');
  id = view[0];
  current = id;
  stopTimer();
  stopTimer = () => {};
  history.replaceState(null, '', `#${id}`);
  document.querySelectorAll('.rail [data-v]').forEach((b) => {
    if (b.dataset.v === id) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  document.querySelector('.actionbar')?.remove();
  $main.textContent = '';
  guard(view[2])();
}

const fill = (...kids) => $main.replaceChildren(...kids.flat(Infinity).filter(Boolean));
const header = (title, ...rest) => h('div', { class: 'head' }, h('h1', {}, title), rest);

// ---- Pantallas --------------------------------------------------------------------------------
const selected = new Set();
const filter = { text: '', status: '', group: '' };
let devices = [];
let profilesCache = [];

async function viewWall() {
  profilesCache = canAdmin() ? await api('GET', '/api/profiles') : [];
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
    if (d.suspended) {
      glass = h('span', { class: 'glass blocked' }, h('strong', {}, 'Servicio suspendido'), h('span', {}, 'Comuníquese con su proveedor.'));
    } else if (d.blocked) {
      glass = h('span', { class: 'glass blocked' }, h('strong', {}, d.blockTitle || 'Bloqueado'), d.blockMessage ? h('span', {}, d.blockMessage) : null);
    } else if (!d.online) {
      glass = h('span', { class: 'glass off' }, 'Sin señal');
    } else {
      glass = h('span', { class: 'glass' }, h('span', { class: 'top' }, h('span', {}, d.title || 'WiFly'), h('span', { class: 'tick' }, sel ? '✓' : '')), h('span', { class: 'state' }, d.state.kiosk === false ? 'Fuera del kiosko' : `${d.effectiveApps.length} apps`));
      if (d.wallpaperSha) glass.style.backgroundImage = bgImage(d.wallpaperSha);
    }
    if (d.blocked || d.suspended || !d.online) {
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
      canAdmin() ? h('button', { onclick: () => assignDialog(ids, load) }, 'Cambiar perfil') : null,
      canAdmin() ? h('button', { onclick: () => confirmDialog('Reiniciar equipos', `Se van a reiniciar ${plural(ids.length, 'equipo', 'equipos')}. Quien esté mirando algo se va a cortar.`, 'Reiniciar', true, () => bulk(ids, 'reboot', {}, 'Reinicio enviado', load)) }, 'Reiniciar') : null,
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
  if (s.mode === 'compat') a.push('Modo compatible: protección intermedia');
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
  const admin = canAdmin();
  const [d, files, profiles] = await Promise.all([api('GET', `/api/devices/${id}`), admin ? api('GET', '/api/files') : [], admin ? api('GET', '/api/profiles') : []]);
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
      admin ? h('td', {}, h('div', { class: 'row-actions' },
        h('button', { onclick: () => setOverride(a.package, !shown) }, shown ? 'Bloquear' : 'Mostrar'),
        a.system ? null : h('button', { class: 'danger', onclick: () => confirmDialog('Desinstalar app', `¿Desinstalar ${a.label} de ${d.name}?`, 'Desinstalar', true, act('uninstall', { package: a.package }, 'Desinstalación enviada')) }, 'Desinstalar'))) : null);
  });

  const dlg = h('dialog', { class: 'drawer' },
    h('div', { class: 'drawer-head' }, h('h2', {}, d.name), h('button', { onclick: () => dlg.close() }, 'Cerrar')),
    h('p', {}, h('span', { class: `pill ${d.online ? 'ok' : ''}` }, d.online ? 'En línea' : `Sin señal, visto ${ago(d.lastSeen)}`), ' ',
      d.suspended ? h('span', { class: 'pill bad' }, 'Servicio suspendido') : d.blocked ? h('span', { class: 'pill bad' }, 'Bloqueado') : null, ' ',
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
      admin ? [
      h('button', { onclick: act('sync', {}, 'Sincronización enviada') }, 'Sincronizar'),
      h('button', { onclick: () => confirmDialog('Reiniciar equipo', `¿Reiniciar ${d.name}?`, 'Reiniciar', true, act('reboot', {}, 'Reinicio enviado')) }, 'Reiniciar'),
      s.kiosk === false
        ? h('button', { onclick: act('enterKiosk', {}, 'Activación enviada') }, 'Activar kiosko')
        : h('button', { onclick: () => confirmDialog('Salir del kiosko', `${d.name} va a volver al launcher original y queda sin protección hasta reactivar el kiosko.`, 'Salir del kiosko', true, act('exitKiosk', {}, 'Salida enviada')) }, 'Salir del kiosko'),
      h('button', { class: 'danger', onclick: () => confirmDialog('Dar de baja', `WiFly deja de administrar ${d.name} y el equipo vuelve a su estado original. Para administrarlo otra vez hay que reinstalarlo con el script.`, 'Dar de baja', true, act('decommission', {}, 'Baja enviada')) }, 'Dar de baja')] : null),

    admin ? [h('h3', {}, 'Datos'),
    h('label', { for: 'dn' }, 'Nombre'), name,
    h('label', { for: 'dg' }, 'Grupo'), group,
    h('label', { for: 'dp' }, 'Perfil'), profile,
    h('label', { for: 'dnotes' }, 'Notas'), notes,
    h('div', { class: 'save-bar' }, h('button', { class: 'primary', onclick: guard(async () => {
      await api('PATCH', `/api/devices/${id}`, { name: name.value, group: group.value, profileId: Number(profile.value), notes: notes.value });
      toast('Cambios guardados');
      await refresh();
    }) }, 'Guardar cambios'))] : null,

    h('h3', {}, 'Aplicaciones en este equipo'),
    appRows.length
      ? h('div', { class: 'table-wrap' }, h('table', {}, h('tbody', {}, appRows)))
      : h('p', { class: 'hint' }, 'El equipo todavía no informó sus aplicaciones.'),
    admin ? h('div', { class: 'inline-add' }, apk, h('button', { onclick: guard(async () => {
      if (!apk.value) throw new Error('Elegí un APK de la lista');
      await bulk([id], 'install', { sha: apk.value }, 'Instalación enviada');
      await refresh();
    }) }, 'Instalar')) : null,

    h('h3', {}, 'Últimos envíos'),
    d.commands.length ? h('div', { class: 'table-wrap' }, h('table', {}, h('tbody', {}, d.commands.map((c) => h('tr', {},
      h('td', {}, COMMAND[c.type] || c.type, c.payload.body ? h('br') : null, c.payload.body ? h('small', {}, c.payload.body) : null),
      h('td', {}, statusPill(c.status), c.detail ? h('br') : null, c.detail ? h('small', {}, c.detail) : null),
      h('td', {}, dateTime(c.createdAt))))))) : h('p', { class: 'hint' }, 'Sin envíos todavía.'),

    admin ? h('div', { class: 'save-bar' }, h('button', { class: 'danger', onclick: () => confirmDialog('Eliminar del panel', `Se borra ${d.name} del panel. El equipo conserva su último perfil, sigue en kiosko y deja de recibir órdenes. Si querés liberarlo, usá Dar de baja.`, 'Eliminar del panel', true, guard(async () => {
      await api('DELETE', `/api/devices/${id}`);
      dlg.close();
      await onChange?.();
    })) }, 'Eliminar del panel')) : null);
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
  const companyName = me.company?.name || 'WiFly';
  const title = h('input', { type: 'text', id: 'f-title', value: p.title, maxlength: 60, placeholder: companyName, oninput: paintPreview });
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
      h('div', { class: 'bar' }, h('span', { class: 'tv-brand' }, h('span', {}, title.value || companyName), me.brandPhrase ? h('small', {}, me.brandPhrase) : null), clock.checked ? h('span', {}, '21:30') : null),
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
      h('p', { class: 'hint' }, `Vacío: se muestra el nombre de la empresa. La frase "${me.brandPhrase || 'definida por el administrador general'}" se agrega debajo, más chica.`),
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
  const [sends, audit] = await Promise.all([api('GET', '/api/sends'), canAdmin() ? api('GET', '/api/audit') : null]);
  fill(
    header('Envíos'),
    h('div', { class: 'sheet' }, h('h2', {}, 'Mensajes y órdenes'),
      sends.length ? sends.map((s) => h('div', {},
        h('h3', {}, COMMAND[s.type] || s.type, ', ', dateTime(s.createdAt)),
        s.payload.body ? h('p', {}, s.payload.title ? `${s.payload.title}: ` : '', s.payload.body) : null,
        h('div', { class: 'table-wrap' }, h('table', {}, h('tbody', {}, s.items.map((i) => h('tr', {}, h('td', {}, i.device), h('td', {}, statusPill(i.status)), h('td', {}, i.detail))))))))
        : h('p', { class: 'hint' }, 'Los mensajes y órdenes que envíes aparecen acá con su estado por equipo.')),
    audit ? h('div', { class: 'sheet' }, h('h2', {}, 'Actividad del panel'), auditTable(audit)) : null);
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
  const cur = h('input', { type: 'password', id: 'c-c', autocomplete: 'current-password' });
  const nxt = h('input', { type: 'password', id: 'c-n', autocomplete: 'new-password' });
  fill(
    header('Cuenta'),
    h('div', { class: 'sheet' }, h('p', {}, 'Entraste como ', h('strong', {}, me.username), `, ${ROLE[me.role]}`, me.company && !isSuper() ? ` de ${me.company.name}` : '', '.'),
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
start().catch(() => {});

// ---- Vistas compartidas -------------------------------------------------------------------------
const ROLE = { superadmin: 'administrador general', admin: 'administrador', operator: 'operador' };

function auditTable(rows) {
  if (!rows.length) return h('p', { class: 'hint' }, 'Sin actividad todavía.');
  return h('div', { class: 'table-wrap' }, h('table', {}, h('tbody', {}, rows.map((a) => h('tr', {},
    h('td', {}, dateTime(a.ts)), a.company !== undefined ? h('td', {}, a.company || 'General') : null,
    h('td', {}, a.actor), h('td', {}, a.action), h('td', {}, a.detail))))));
}

// ---- Usuarios --------------------------------------------------------------------------------------
/** Sin empresa elegida (administrador general): los administradores generales. Con empresa: sus usuarios. */
function usersSheet(users, roles, title, intro) {
  const user = h('input', { type: 'text', id: 'nu-u', maxlength: 40, autocomplete: 'off' });
  const pass = h('input', { type: 'password', id: 'nu-p', autocomplete: 'new-password' });
  const role = h('select', { id: 'nu-r' }, roles.map(([v, t]) => h('option', { value: v }, t)));
  const reset = (u) => {
    const p = h('input', { type: 'password', id: 'rp', autocomplete: 'new-password' });
    const d = dialog(`Nueva clave para ${u.username}`, h('div', {}, h('label', { for: 'rp' }, 'Clave nueva (10 caracteres o más)'), p,
      h('p', { class: 'hint' }, 'Sus sesiones abiertas se cierran. Pasale la clave por un medio seguro.')), [
      h('button', { onclick: () => d.close() }, 'Cancelar'),
      h('button', { class: 'primary', onclick: guard(async () => { await api('POST', `/api/users/${u.id}/password`, { password: p.value }); d.close(); toast('Clave cambiada'); }) }, 'Cambiar clave'),
    ]);
    p.focus();
  };
  const manageable = (u) => u.username !== me.username && (isSuper() || u.role === 'operator');
  return [
    h('div', { class: 'sheet' }, h('h2', {}, title), intro ? h('p', {}, intro) : null,
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Usuario', 'Rol', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, users.map((u) => h('tr', {}, h('td', {}, u.username, u.username === me.username ? ' (vos)' : ''), h('td', {}, u.roleLabel),
          h('td', {}, manageable(u) ? h('div', { class: 'row-actions' },
            h('button', { onclick: () => reset(u) }, 'Cambiar clave'),
            h('button', { class: 'danger', onclick: () => confirmDialog('Eliminar usuario', `${u.username} ya no va a poder entrar al panel.`, 'Eliminar usuario', true, guard(async () => { await api('DELETE', `/api/users/${u.id}`); go(current); })) }, 'Eliminar')) : null))))))),
    h('div', { class: 'sheet' }, h('h2', {}, 'Crear usuario'),
      h('label', { for: 'nu-u' }, 'Usuario'), user,
      h('label', { for: 'nu-p' }, 'Clave (10 caracteres o más)'), pass,
      roles.length > 1 ? [h('label', { for: 'nu-r' }, 'Rol'), role] : null,
      roles.some(([v]) => v === 'operator') ? h('p', { class: 'hint' }, 'El operador solo puede enviar mensajes, bloquear y desbloquear equipos.') : null,
      h('div', { class: 'save-bar' }, h('button', { class: 'primary', onclick: guard(async () => {
        await api('POST', '/api/users', { username: user.value, password: pass.value, role: role.value });
        toast(`Usuario ${user.value} creado`);
        go(current);
      }) }, 'Crear usuario'))),
  ];
}

async function viewUsers() {
  const users = await api('GET', '/api/users');
  const roles = isSuper() ? [['admin', 'Administrador de la empresa'], ['operator', 'Operador']] : [['operator', 'Operador']];
  fill(header('Usuarios'), usersSheet(users, roles, `Usuarios de ${me.company.name}`, ''));
}

// ---- Empresas (administrador general) ------------------------------------------------------------
const dayDate = (ts) => new Date(ts).toLocaleDateString('es-AR', { dateStyle: 'medium' });
function companyState(c) {
  if (c.status === 'active') return h('span', { class: 'pill ok' }, 'Activa');
  if (c.devicesSuspended) return h('span', { class: 'pill bad' }, 'Suspendida, TV Box bloqueados');
  return [h('span', { class: 'pill warn' }, 'Panel suspendido'), h('br'), h('small', {}, `TV Box se bloquean el ${dayDate(c.devicesSuspendAt)}`)];
}

async function viewCompanies() {
  const [companies, settings] = await Promise.all([api('GET', '/api/companies'), api('GET', '/api/settings')]);
  const total = companies.reduce((n, c) => n + c.monthDevices, 0);
  const rows = companies.map((c) => h('tr', {},
    h('td', {}, h('strong', {}, c.name), c.notes ? [h('br'), h('small', {}, c.notes)] : null),
    h('td', {}, companyState(c)),
    h('td', { class: 'num' }, c.devices), h('td', { class: 'num' }, c.online), h('td', { class: 'num' }, c.monthDevices),
    h('td', {}, c.admins.join(', ') || h('span', { class: 'hint' }, 'Sin administrador')),
    h('td', {}, h('div', { class: 'row-actions' },
      h('button', { class: 'primary', onclick: guard(() => setContext(c.id)) }, 'Administrar'),
      c.status === 'active'
        ? h('button', { class: 'danger', onclick: () => confirmDialog(`Suspender ${c.name}`, `El panel de ${c.name} se corta ahora. Si no se registra el pago en ${settings.graceDays} días, sus TV Box muestran "Servicio suspendido".`, 'Suspender', true, guard(async () => { await api('POST', `/api/companies/${c.id}/suspend`, {}); toast(`${c.name} suspendida`); go('companies'); })) }, 'Suspender')
        : h('button', { onclick: guard(async () => { await api('POST', `/api/companies/${c.id}/activate`, {}); toast(`Pago registrado: ${c.name} reactivada`); go('companies'); }) }, 'Marcar pagada'),
      h('button', { onclick: () => editCompany(c) }, 'Editar'),
      c.devices === 0 ? h('button', { class: 'plain', onclick: () => confirmDialog(`Eliminar ${c.name}`, 'Se borran la empresa, sus usuarios, perfiles y archivos. No se puede deshacer.', 'Eliminar empresa', true, guard(async () => { await api('DELETE', `/api/companies/${c.id}`); go('companies'); })) }, 'Eliminar') : null))));
  fill(
    header('Empresas', h('span', { class: 'count' }, companies.length ? `${plural(companies.length, 'empresa', 'empresas')}, ${plural(total, 'equipo facturable', 'equipos facturables')} este mes` : ''),
      h('span', { class: 'spacer' }), h('button', { class: 'primary', onclick: newCompany }, 'Crear empresa')),
    companies.length
      ? h('div', { class: 'sheet' }, h('div', { class: 'table-wrap' }, h('table', { class: 'companies' },
        h('thead', {}, h('tr', {}, ['Empresa', 'Estado', 'Equipos', 'En línea', 'Facturables este mes', 'Administradores', ''].map((t, i) => h('th', { class: i >= 2 && i <= 4 ? 'num' : null }, t)))),
        h('tbody', {}, rows))))
      : h('div', { class: 'empty' }, h('h2', {}, 'Todavía no hay empresas'), h('p', {}, 'Creá la primera empresa con su administrador. Él va a poder cargar sus equipos, perfiles y apps.'),
        h('button', { class: 'primary', onclick: newCompany }, 'Crear empresa')));
}

function newCompany() {
  const name = h('input', { type: 'text', id: 'nc-n', maxlength: 60 });
  const user = h('input', { type: 'text', id: 'nc-u', maxlength: 40, autocomplete: 'off' });
  const pass = h('input', { type: 'password', id: 'nc-p', autocomplete: 'new-password' });
  const d = dialog('Crear empresa', h('div', {},
    h('label', { for: 'nc-n' }, 'Nombre de la empresa'), name,
    h('h3', {}, 'Administrador de la empresa'),
    h('label', { for: 'nc-u' }, 'Usuario'), user,
    h('label', { for: 'nc-p' }, 'Clave (10 caracteres o más)'), pass,
    h('p', { class: 'hint' }, 'Podés dejarlo vacío y crearlo después desde Usuarios, administrando la empresa.')), [
    h('button', { onclick: () => d.close() }, 'Cancelar'),
    h('button', { class: 'primary', onclick: guard(async () => {
      await api('POST', '/api/companies', { name: name.value, adminUser: user.value || undefined, adminPassword: pass.value });
      d.close();
      toast(`${name.value} creada`);
      go('companies');
    }) }, 'Crear empresa'),
  ]);
  name.focus();
}

function editCompany(c) {
  const name = h('input', { type: 'text', id: 'ec-n', maxlength: 60, value: c.name });
  const notes = h('textarea', { id: 'ec-o', maxlength: 500, value: c.notes });
  const d = dialog(`Editar ${c.name}`, h('div', {},
    h('label', { for: 'ec-n' }, 'Nombre'), name,
    h('p', { class: 'hint' }, 'Es el nombre que ven la empresa en su panel y sus clientes en los TV Box.'),
    h('label', { for: 'ec-o' }, 'Notas internas'), notes), [
    h('button', { onclick: () => d.close() }, 'Cancelar'),
    h('button', { class: 'primary', onclick: guard(async () => {
      await api('PATCH', `/api/companies/${c.id}`, { name: name.value, notes: notes.value });
      d.close();
      go('companies');
    }) }, 'Guardar cambios'),
  ]);
}

// ---- Facturación ----------------------------------------------------------------------------------
let billingMonth = null;
const monthLabel = (m) => {
  const [y, mo] = m.split('-').map(Number);
  const t = new Date(y, mo - 1, 1).toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
  return t.charAt(0).toUpperCase() + t.slice(1);
};

async function viewBilling() {
  const r = await api('GET', `/api/billing${billingMonth ? `?month=${billingMonth}` : ''}`);
  billingMonth = r.month;
  const sel = h('select', { 'aria-label': 'Mes', onchange: (e) => { billingMonth = e.target.value; go('billing'); } },
    r.months.map((m) => h('option', { value: m, selected: m === r.month }, monthLabel(m))));
  const statusText = { active: 'Activa', suspended: 'Suspendida', deleted: 'Eliminada' };
  fill(
    header('Facturación', sel, r.closed ? h('span', { class: 'pill ok' }, 'Mes cerrado') : h('span', { class: 'pill warn' }, 'Mes en curso'),
      h('span', { class: 'spacer' }), h('a', { class: 'button', href: `/api/billing.csv?month=${r.month}`, download: '' }, 'Exportar a Excel (CSV)')),
    h('p', {}, 'Se factura todo equipo que estuvo registrado al menos un día del mes, aunque después se haya dado de baja. ',
      r.closed ? 'Este mes ya cerró y su número no cambia.' : 'Este número puede subir hasta que termine el mes.'),
    h('div', { class: 'sheet' }, h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Empresa'), h('th', {}, 'Estado'), h('th', { class: 'num' }, 'Equipos facturables'), h('th', {}, ''))),
      h('tbody', {}, r.rows.map((x) => h('tr', {}, h('td', {}, x.name), h('td', {}, statusText[x.status] || x.status), h('td', { class: 'num' }, x.devices),
        h('td', {}, x.devices ? h('a', { href: `/api/billing/${x.companyId}/devices.csv?month=${r.month}`, download: '' }, 'Detalle por equipo') : null))),
      h('tr', { class: 'total' }, h('td', {}, 'Total'), h('td', {}), h('td', { class: 'num' }, r.total), h('td', {})))))));
}

// ---- Configuración general ------------------------------------------------------------------------
async function viewSettings() {
  const [settings, users, audit] = await Promise.all([api('GET', '/api/settings'), api('GET', '/api/users'), api('GET', '/api/audit')]);
  const phrase = h('input', { type: 'text', id: 's-ph', maxlength: 40, value: settings.brandPhrase, placeholder: 'por DBI', oninput: () => paint() });
  const grace = h('input', { type: 'number', id: 's-gr', min: 0, max: 365, value: settings.graceDays });
  const sample = h('div', { class: 'brand-sample' });
  const paint = () => sample.replaceChildren(...[h('span', { class: 'brand-name' }, 'Hotel Sur'), phrase.value ? h('span', { class: 'brand-phrase' }, phrase.value) : null].filter(Boolean));
  paint();
  fill(
    header('Configuración'),
    updatesSheet(),
    h('div', { class: 'sheet' }, h('h2', {}, 'Marca'),
      h('p', {}, `El sistema se llama ${me.product}. Cada empresa se muestra con su nombre y esta frase debajo, más chica, en su panel y en sus TV Box.`),
      h('label', { for: 's-ph' }, 'Frase fija'), phrase,
      h('p', { class: 'hint' }, 'Así se ve:'), sample,
      h('h2', { class: 'spaced' }, 'Suspensión por falta de pago'),
      h('label', { for: 's-gr' }, 'Días de gracia antes de suspender los TV Box'), grace,
      h('p', { class: 'hint' }, 'Al suspender una empresa, su panel se corta en el momento. Si en estos días no se registra el pago, sus TV Box muestran "Servicio suspendido, comuníquese con su proveedor".'),
      h('div', { class: 'save-bar' }, h('button', { class: 'primary', onclick: guard(async () => {
        await api('PUT', '/api/settings', { brandPhrase: phrase.value, graceDays: Number(grace.value) });
        me.brandPhrase = phrase.value.trim();
        toast('Configuración guardada. Los TV Box la reciben en unos segundos.');
      }) }, 'Guardar configuración'))),
    usersSheet(users, [['superadmin', 'Administrador general']], 'Administradores generales', 'Pueden ver y administrar todas las empresas.'),
    h('div', { class: 'sheet' }, h('h2', {}, 'Actividad general'), auditTable(audit)));
}

// ---- Actualizaciones desde GitHub ------------------------------------------------------------------
const UPDATE_STATE = {
  idle: ['Al día', 'ok'], pending: ['Esperando al actualizador', 'warn'], checking: ['Buscando versiones', 'warn'],
  updating: ['Actualizando', 'warn'], done: ['Actualizado', 'ok'], rolled_back: ['Falló, se volvió a la versión anterior', 'bad'], error: ['Error', 'bad'],
};

/** Mientras el servidor se reinicia el panel pierde conexión: sigue preguntando hasta que vuelve. */
function updatesSheet() {
  const box = h('div', { class: 'sheet' });
  let timer = null;
  let offline = false;
  let shownVersion = null;

  const schedule = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(load, ms);
  };
  const prevStop = stopTimer;
  stopTimer = () => { clearTimeout(timer); prevStop(); };

  async function load() {
    if (!box.isConnected) return;
    let st;
    try {
      const r = await fetch('/api/updates', { headers: { 'x-wifly': '1' } });
      if (r.status === 401) return showLogin('El servidor se actualizó. Volvé a entrar.');
      st = await r.json();
      if (!r.ok) throw new Error(st.error);
    } catch {
      offline = true;
      box.replaceChildren(h('h2', {}, 'Actualizaciones'), h('div', { class: 'note' }, 'El servidor se está reiniciando con la versión nueva. Esta página vuelve sola en cuanto responda.'));
      return schedule(4000);
    }
    if (offline && shownVersion && st.current !== shownVersion) {
      toast(`Servidor actualizado a ${st.current}. Recargando el panel…`);
      return setTimeout(() => location.reload(), 1500);
    }
    offline = false;
    shownVersion = st.current;
    paint(st);
    if (['pending', 'checking', 'updating'].includes(st.state)) schedule(3000);
  }

  function paint(st) {
    const [label, tone] = st.state === 'idle' && st.available.length ? ['Hay una versión nueva', 'warn'] : UPDATE_STATE[st.state] || [st.state, ''];
    const busy = ['pending', 'checking', 'updating'].includes(st.state);
    if (!st.enabled) {
      box.replaceChildren(h('h2', {}, 'Actualizaciones'),
        h('p', {}, `Versión instalada: `, h('strong', {}, st.current), '.'),
        h('div', { class: 'note' }, 'Las actualizaciones desde GitHub no están activadas en este servidor. Se activan una sola vez desde la consola del CT con:'),
        h('pre', {}, 'cd /root/wifly/server\nsudo ./actualizador/activar-actualizaciones.sh usuario/repositorio'));
      return;
    }
    const newest = st.available[st.available.length - 1];
    box.replaceChildren(...[
      h('h2', {}, 'Actualizaciones'),
      h('p', {}, 'Versión instalada: ', h('strong', {}, st.current), '. Repositorio: ', h('code', {}, st.repo), '. ',
        h('span', { class: `pill ${tone}` }, label)),
      st.message ? h('p', {}, st.message) : null,
      st.lastCheck ? h('p', { class: 'hint' }, `Última búsqueda: ${dateTime(st.lastCheck)}.`) : null,
      h('div', { class: 'wrap-actions' },
        h('button', { disabled: busy, onclick: guard(async () => { paint(await api('POST', '/api/updates/check', {})); schedule(2000); }) }, 'Buscar actualizaciones'),
        newest ? h('button', { class: 'primary', disabled: busy, onclick: () => confirmDialog(`Actualizar a ${newest}`,
          `Se respaldan los datos, el panel y los TV Box se desconectan entre 1 y 3 minutos, y el servidor arranca con ${newest}. Si la versión nueva no responde, vuelve sola a ${st.current} con sus datos. Los TV Box siguen funcionando durante la actualización.`,
          `Actualizar a ${newest}`, false, async () => { paint(await api('POST', '/api/updates/apply', { version: newest })); schedule(2000); }) }, `Actualizar a ${newest}`) : null),
      st.available.length > 1 ? h('p', { class: 'hint' }, `Versiones nuevas disponibles: ${st.available.join(', ')}. Se instala la más reciente.`) : null,
      st.log.length ? h('details', { open: busy || ['error', 'rolled_back'].includes(st.state) }, h('summary', {}, 'Registro'), h('pre', {}, st.log.join('\n'))) : null,
    ].filter(Boolean));
  }

  box.append(h('h2', {}, 'Actualizaciones'), h('p', { class: 'hint' }, 'Cargando…'));
  // Se carga cuando la sección ya está en la página.
  schedule(0);
  return box;
}
