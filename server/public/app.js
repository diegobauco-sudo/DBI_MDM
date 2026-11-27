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
  if (r.status === 401 && url !== '/api/login' && !url.startsWith('/api/password/')) {
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
    h('button', { class: 'primary', type: 'submit' }, 'Entrar'),
    h('button', { type: 'button', class: 'linkish', onclick: () => showForgot(user.value) }, 'Olvidé mi clave')))));
  user.focus();
}

/** Pide el enlace de recuperación. La respuesta es la misma exista o no el usuario. */
function showForgot(prefill = '') {
  const login = h('input', { type: 'text', id: 'fl', autocomplete: 'username', required: true, value: prefill });
  const msg = h('p', { class: 'err', hidden: true });
  const send = h('button', { class: 'primary', type: 'submit' }, 'Enviar enlace');
  $app.replaceChildren(h('div', { class: 'login' }, h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      send.disabled = true;
      try {
        const r = await api('POST', '/api/password/forgot', { login: login.value });
        msg.className = 'ok-msg';
        msg.textContent = r.message;
      } catch (ex) {
        msg.className = 'err';
        msg.textContent = ex.message;
        send.disabled = false;
      }
      msg.hidden = false;
    },
  }, h('div', { class: 'glass' },
    h('div', { class: 'brand' }, h('img', { src: 'icon.svg', alt: '' }), 'WiFly MDM'),
    h('h2', {}, 'Recuperar la clave'),
    h('p', {}, 'Escribí tu usuario o tu email. Te mandamos un enlace para elegir una clave nueva, válido por una hora.'),
    h('label', { for: 'fl' }, 'Usuario o email'), login,
    msg, send,
    h('button', { type: 'button', class: 'linkish', onclick: () => showLogin() }, 'Volver a entrar')))));
  login.focus();
}

/** Página del enlace del correo: elegir una clave nueva. */
async function showReset(token) {
  history.replaceState(null, '', location.pathname);
  const box = h('div', { class: 'glass' }, h('div', { class: 'brand' }, h('img', { src: 'icon.svg', alt: '' }), 'WiFly MDM'));
  $app.replaceChildren(h('div', { class: 'login' }, h('form', { onsubmit: (e) => e.preventDefault() }, box)));
  let info;
  try {
    info = await api('POST', '/api/password/reset-info', { token });
  } catch (ex) {
    box.append(h('h2', {}, 'Enlace vencido'), h('p', { class: 'err' }, ex.message), h('button', { class: 'primary', type: 'button', onclick: () => showForgot() }, 'Pedir otro enlace'));
    return;
  }
  const pw = passwordField('rp1', 'Clave nueva');
  const again = h('input', { type: 'password', id: 'rp2', autocomplete: 'new-password' });
  const err = h('p', { class: 'err', hidden: true });
  box.append(h('h2', {}, `Hola, ${info.displayName}`), h('p', {}, 'Elegí la clave nueva para el usuario ', h('strong', {}, info.username), '.'),
    pw.el, h('label', { for: 'rp2' }, 'Repetí la clave nueva'), again, err,
    h('button', { class: 'primary', type: 'button', onclick: async () => {
      err.hidden = true;
      try {
        if (pw.input.value !== again.value) throw new Error('Las dos claves no coinciden');
        await api('POST', '/api/password/reset', { token, password: pw.input.value });
        showLogin();
        toast('Clave cambiada. Ya podés entrar con la nueva.');
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      }
    } }, 'Guardar clave nueva'));
  pw.input.focus();
}

// ---- Formularios compartidos -----------------------------------------------------------------
const PW_RULES = [
  ['10 caracteres o más', (s) => s.length >= 10],
  ['una mayúscula', (s) => /[A-ZÁÉÍÓÚÑ]/.test(s)],
  ['una minúscula', (s) => /[a-záéíóúñ]/.test(s)],
  ['un número', (s) => /[0-9]/.test(s)],
  ['un carácter especial', (s) => /[^A-Za-z0-9ÁÉÍÓÚÑáéíóúñ]/.test(s)],
];

/** Clave al azar que cumple la política, sin caracteres que se confundan al dictarla. */
function generatePassword() {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '!#$%&*+-=?@_'];
  const all = sets.join('');
  const rnd = (n) => crypto.getRandomValues(new Uint32Array(1))[0] % n;
  const chars = sets.map((set) => set[rnd(set.length)]);
  while (chars.length < 14) chars.push(all[rnd(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) { const j = rnd(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}

/** Campo de clave con los requisitos a la vista, que se tildan a medida que se cumplen. */
function passwordField(id, label) {
  const input = h('input', { type: 'password', id, autocomplete: 'new-password', 'aria-describedby': `${id}-rules` });
  const items = PW_RULES.map(([t]) => h('li', {}, t));
  const paint = () => PW_RULES.forEach(([, test], i) => items[i].classList.toggle('ok', test(input.value)));
  input.addEventListener('input', paint);
  const show = h('button', { type: 'button', class: 'plain', onclick: () => {
    input.type = input.type === 'password' ? 'text' : 'password';
    show.textContent = input.type === 'password' ? 'Mostrar' : 'Ocultar';
  } }, 'Mostrar');
  const gen = h('button', { type: 'button', class: 'plain', onclick: () => {
    input.value = generatePassword();
    input.type = 'text';
    show.textContent = 'Ocultar';
    paint();
  } }, 'Generar');
  paint();
  return { input, el: h('div', { class: 'field' }, h('label', { for: id }, label), h('div', { class: 'pw-row' }, input, show, gen),
    h('ul', { class: 'pw-rules', id: `${id}-rules` }, items)) };
}

/** Un campo con su etiqueta. `span` lo hace ocupar las dos columnas. */
function field(id, label, props = {}, { span = false, hint = '', el = 'input' } = {}) {
  const input = h(el, { id, type: el === 'input' ? 'text' : undefined, ...props });
  return { input, el: h('div', { class: span ? 'span2' : null }, h('label', { for: id }, label), input, hint ? h('p', { class: 'hint' }, hint) : null) };
}

/** Datos de un usuario del panel: nombre, nombre a mostrar, teléfono y email. */
function userFields(prefix, u = {}, { emailHint = 'También sirve para recuperar la clave.', emailRequired = true } = {}) {
  const f = {
    fullName: field(`${prefix}-fn`, 'Nombre completo', { value: u.fullName || '', maxlength: 80, autocomplete: 'off' }),
    displayName: field(`${prefix}-dn`, 'Nombre a mostrar en el panel', { value: u.displayName || '', maxlength: 40, autocomplete: 'off' }, { hint: 'Vacío: el nombre completo.' }),
    phone: field(`${prefix}-ph`, 'Teléfono', { type: 'tel', value: u.phone || '', maxlength: 30, autocomplete: 'off' }),
    email: field(`${prefix}-em`, emailRequired ? 'Email' : 'Email (opcional)', { type: 'email', value: u.email || '', maxlength: 120, autocomplete: 'off' }, { hint: emailHint }),
  };
  return {
    els: Object.values(f).map((x) => x.el),
    values: () => Object.fromEntries(Object.entries(f).map(([k, x]) => [k, x.input.value])),
    focus: () => f.fullName.input.focus(),
  };
}

const TAX = [['', 'Elegí una opción'], ['cf', 'Consumidor final'], ['mono', 'Monotributista'], ['ri', 'Responsable inscripto']];

/** Datos fiscales y de contacto de una empresa. */
function companyFields(c = {}) {
  const cond = h('select', { id: 'co-tc' }, TAX.map(([v, t]) => h('option', { value: v, selected: (c.taxCondition || '') === v, disabled: v === '' }, t)));
  const f = {
    name: field('co-n', 'Nombre de la empresa', { value: c.name || '', maxlength: 60 }, { hint: 'Así la ven en su panel y en los TV Box.' }),
    legalName: field('co-ln', 'Razón social', { value: c.legalName || '', maxlength: 120 }),
    taxAddress: field('co-ta', 'Domicilio fiscal', { value: c.taxAddress || '', maxlength: 200 }, { span: true }),
    taxCondition: { input: cond, el: h('div', {}, h('label', { for: 'co-tc' }, 'Tipo de impuesto'), cond) },
    taxId: field('co-ti', 'CUIT, DNI o CUIL', { value: c.taxId || '', maxlength: 20, inputmode: 'numeric' }, { hint: 'Monotributista y responsable inscripto: CUIT.' }),
    email: field('co-em', 'Email de contacto', { type: 'email', value: c.email || '', maxlength: 120 }, { hint: 'Si el administrador no carga uno propio, recupera su clave con este.' }),
    phone: field('co-ph', 'Teléfono de contacto', { type: 'tel', value: c.phone || '', maxlength: 30 }),
  };
  return {
    els: Object.values(f).map((x) => x.el),
    values: () => Object.fromEntries(Object.entries(f).map(([k, x]) => [k, x.input.value])),
    focus: () => f.name.input.focus(),
  };
}

// ---- Marco -----------------------------------------------------------------------------------
// Cada vista dice si es del sistema (fuera de las empresas), de la empresa que se administra, o la cuenta propia,
// y quién la ve. Los permisos los manda el servidor en /api/me según el rol.
const isGlobal = () => !!me?.global;
const isSuper = () => me?.role === 'superadmin';
const perm = (p) => !!me?.perms?.[p];
const cRole = () => me?.companyRole || null;
const canAdmin = () => cRole() === 'admin';
const canAct = () => cRole() === 'admin' || cRole() === 'operator';
const isViewer = () => cRole() === 'viewer';
const VIEWS = [
  ['companies', 'Empresas', viewCompanies, 'system', () => isGlobal()],
  ['billing', 'Facturación', viewBilling, 'system', () => perm('billing')],
  ['sysusers', 'Usuarios', viewSystemUsers, 'system', () => perm('systemUsers')],
  ['backups', 'Respaldos', () => viewBackups('general'), 'system', () => perm('backupsGeneral')],
  ['settings', 'Configuración', viewSettings, 'system', () => perm('settings')],
  ['wall', 'Pantallas', viewWall, 'company', () => !!cRole()],
  ['clients', 'Clientes', viewClients, 'company', () => !!cRole()],
  ['profiles', 'Perfiles', viewProfiles, 'company', canAdmin],
  ['library', 'Biblioteca', viewLibrary, 'company', canAdmin],
  ['sends', 'Envíos', viewSends, 'company', () => !!cRole()],
  ['enroll', 'Alta de equipos', viewEnroll, 'company', canAct],
  ['users', 'Usuarios', viewUsers, 'company', () => canAdmin() || isViewer()],
  ['cbackups', 'Respaldos', () => viewBackups('empresa'), 'company', canAdmin],
  ['account', 'Cuenta', viewAccount, 'account', () => true],
];
let current = 'wall';
let $main;
let me = null;
const allowed = (view) => view[4]();

/** Nombre de la empresa con la frase fija más chica, como en la pantalla del TV Box. */
function brandBlock(name, phrase) {
  return h('div', { class: 'brand' }, h('img', { src: 'icon.svg', alt: '' }),
    h('span', { class: 'brand-text' }, h('span', { class: 'brand-name' }, name), phrase ? h('span', { class: 'brand-phrase' }, phrase) : null));
}

async function start() {
  me = await api('GET', '/api/me');
  const views = VIEWS.filter(allowed);
  const globalViews = views.filter((v) => v[3] === 'system');
  const companyViews = views.filter((v) => v[3] === 'company');
  const navButton = ([id, label]) => h('button', { 'data-v': id, onclick: () => go(id) }, label);
  $main = h('main', { id: 'main' });
  const brand = me.company && !isGlobal() ? brandBlock(me.company.name, me.brandPhrase) : brandBlock(me.product);
  $app.replaceChildren(h('div', { class: 'shell' },
    h('nav', { class: 'rail', 'aria-label': 'Secciones' },
      brand,
      globalViews.map(navButton),
      isGlobal() && me.company ? h('div', { class: 'rail-company' },
        h('span', { class: 'rail-label' }, isViewer() ? 'Viendo (solo lectura)' : 'Administrando'),
        h('strong', {}, me.company.name),
        h('button', { class: 'rail-back', onclick: guard(() => setContext(null)) }, 'Volver a empresas')) : null,
      companyViews.map(navButton),
      h('div', { class: 'bottom' },
        h('div', { class: 'rail-user' }, me.displayName),
        navButton(['account', 'Cuenta']),
        h('button', { onclick: guard(async () => { await api('POST', '/api/logout', {}); showLogin(); }) }, 'Salir'))),
    $main));
  const first = isGlobal() && !me.company ? 'companies' : 'wall';
  const hash = location.hash.slice(1);
  if (hash.startsWith('backups-google=')) {
    // Google vuelve acá después de conectar Drive.
    const p = new URLSearchParams(hash);
    setTimeout(() => toast(p.get('msg') || '', p.get('backups-google') !== 'ok'), 300);
    return go(me.company && canAdmin() ? 'cbackups' : 'backups');
  }
  go(hash || first);
}

async function setContext(companyId) {
  await api('POST', '/api/context', { companyId });
  location.hash = companyId ? 'wall' : 'companies';
  await start();
}

function go(id) {
  const view = VIEWS.find((v) => v[0] === id && allowed(v)) || VIEWS.find((v) => allowed(v) && v[0] !== 'account');
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
const filter = { text: '', status: '', group: '', client: '' };
let devices = [];
let profilesCache = [];
let clientsCache = [];
const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
};
let wallMode = store.get('wifly-wall-mode', 'screens');
const clientLabel = (c) => `${c.extId} · ${c.name}`;

async function viewWall() {
  [profilesCache, clientsCache] = await Promise.all([canAdmin() ? api('GET', '/api/profiles') : [], api('GET', '/api/clients')]);
  const wallBox = h('div');
  const count = h('span', { class: 'count' });
  const groupSel = h('select', { 'aria-label': 'Grupo', onchange: (e) => { filter.group = e.target.value; paint(); } });
  if (filter.client && !clientsCache.some((c) => String(c.id) === filter.client) && filter.client !== 'none') filter.client = '';
  const clientSel = clientsCache.length ? h('select', { 'aria-label': 'Cliente', onchange: (e) => { filter.client = e.target.value; paint(); } },
    h('option', { value: '' }, 'Todos los clientes'), h('option', { value: 'none', selected: filter.client === 'none' }, 'Sin cliente'),
    clientsCache.map((c) => h('option', { value: c.id, selected: String(c.id) === filter.client }, clientLabel(c)))) : null;
  const modeBtn = (mode, label) => h('button', { 'aria-pressed': String(wallMode === mode), onclick: () => { wallMode = mode; store.set('wifly-wall-mode', mode); toggle.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.m === mode))); paint(); }, 'data-m': mode }, label);
  const toggle = h('div', { class: 'view-toggle', role: 'group', 'aria-label': 'Cómo ver los equipos' }, modeBtn('screens', 'Pantallas'), modeBtn('list', 'Lista'));
  fill(
    header('Pantallas', count),
    h('div', { class: 'filters' },
      h('input', { type: 'search', placeholder: 'Buscar por nombre, modelo o IP', 'aria-label': 'Buscar', value: filter.text, oninput: (e) => { filter.text = e.target.value.toLowerCase(); paint(); } }),
      h('select', { 'aria-label': 'Estado', onchange: (e) => { filter.status = e.target.value; paint(); } },
        [['', 'Todos los estados'], ['online', 'En línea'], ['offline', 'Sin señal'], ['blocked', 'Bloqueados'], ['alert', 'Con alertas']].map(([v, t]) => h('option', { value: v, selected: filter.status === v }, t))),
      groupSel, clientSel,
      canAct() ? h('button', { onclick: () => { visible().forEach((d) => selected.add(d.id)); paint(); } }, 'Seleccionar los visibles') : null,
      toggle),
    wallBox);

  const visible = () => devices.filter((d) => {
    const hay = `${d.name} ${d.state.model || ''} ${d.state.ip || ''} ${d.group} ${d.clientExtId} ${d.clientName}`.toLowerCase();
    if (filter.text && !hay.includes(filter.text)) return false;
    if (filter.group && d.group !== filter.group) return false;
    if (filter.client === 'none' && d.clientId) return false;
    if (filter.client && filter.client !== 'none' && String(d.clientId) !== filter.client) return false;
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
    } else if (wallMode === 'list') {
      const list = visible();
      wallBox.replaceChildren(list.length ? deviceTable(list) : h('div', { class: 'empty' }, h('p', {}, 'Ningún equipo coincide con el filtro.')));
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

  /** Vista en lista: una fila por equipo, con la misma selección que las pantallas. */
  function deviceTable(list) {
    const allSel = list.every((d) => selected.has(d.id));
    const toggleOne = (d) => { if (selected.has(d.id)) selected.delete(d.id); else selected.add(d.id); paint(); };
    return h('div', { class: 'sheet' }, h('div', { class: 'table-wrap' }, h('table', { class: 'devices' },
      h('thead', {}, h('tr', {},
        h('th', {}, canAct() && h('input', { type: 'checkbox', checked: allSel, 'aria-label': 'Seleccionar todos los visibles', onchange: () => { list.forEach((d) => (allSel ? selected.delete(d.id) : selected.add(d.id))); paint(); } })),
        ['Equipo', 'Cliente', 'Estado', 'Red', 'Perfil', ''].map((t) => h('th', { class: t === 'Red' || t === 'Perfil' ? 'opt' : null }, t)))),
      h('tbody', {}, list.map((d) => {
        const alerts = alertsOf(d);
        let state;
        if (d.suspended) state = [h('span', { class: 'dot bad' }), 'Servicio suspendido'];
        else if (d.blocked) state = [h('span', { class: 'dot bad' }), `Bloqueado${d.blockTitle ? `: ${d.blockTitle}` : ''}`];
        else if (d.online) state = [h('span', { class: 'dot on' }), d.state.kiosk === false ? 'En línea, fuera del kiosko' : 'En línea'];
        else state = [h('span', { class: 'dot' }), `Sin señal, visto ${ago(d.lastSeen)}`];
        return h('tr', { class: selected.has(d.id) ? 'sel' : null },
          h('td', {}, canAct() && h('input', { type: 'checkbox', checked: selected.has(d.id), 'data-id': d.id, 'aria-label': `Seleccionar ${d.name}`, onchange: () => toggleOne(d) })),
          h('td', {}, h('strong', {}, d.name), h('br'), h('small', {}, [d.state.model, d.group].filter(Boolean).join(' · '))),
          h('td', {}, d.clientId ? [d.clientName, h('br'), h('small', {}, `ID ${d.clientExtId}`)] : h('span', { class: 'hint' }, 'Sin cliente')),
          h('td', {}, state, alerts.length ? [h('br'), h('small', { class: 'alert-line' }, alerts[0])] : null),
          h('td', { class: 'opt' }, d.state.network || '', d.state.ip ? [h('br'), h('small', {}, d.state.ip)] : null),
          h('td', { class: 'opt' }, d.profileName),
          h('td', {}, h('button', { class: 'plain', onclick: () => openDevice(d.id, load) }, 'Ver')));
      })))));
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
      glass = h('span', { class: 'glass' }, h('span', { class: 'top' }, h('span', {}, d.title || 'WiFly'), canAct() ? h('span', { class: 'tick' }, sel ? '✓' : '') : null), h('span', { class: 'state' }, d.state.kiosk === false ? 'Fuera del kiosko' : `${d.effectiveApps.length} apps`));
      if (d.wallpaperSha) glass.style.backgroundImage = bgImage(d.wallpaperSha);
    }
    if (d.blocked || d.suspended || !d.online) {
      if (sel) glass.prepend(h('span', { class: 'tick' }, '✓'));
    }
    return h('div', { class: 'unit' },
      h('button', {
        class: 'screen', 'data-id': d.id, 'aria-pressed': String(sel),
        'aria-label': `Seleccionar ${d.name}`,
        onclick: () => { if (!canAct()) return openDevice(d.id, load); if (sel) selected.delete(d.id); else selected.add(d.id); paint(); },
      }, glass, h('span', { class: `power${d.online ? ' on' : ''}` })),
      h('div', { class: 'caption' },
        h('div', {},
          h('div', { class: 'name' }, d.name),
          h('div', { class: 'sub' }, d.online ? (d.state.network || 'En línea') : `Visto ${ago(d.lastSeen)}`),
          d.clientId ? h('div', { class: 'sub' }, `Cliente ${d.clientExtId}, ${d.clientName}`) : null,
          alerts.length ? h('div', { class: 'alert-line' }, alerts[0]) : null),
        h('button', { class: 'plain', onclick: () => openDevice(d.id, load) }, 'Ver')));
  }

  function paintBar() {
    document.querySelector('.actionbar')?.remove();
    if (!selected.size || !canAct()) return;
    const ids = [...selected];
    $app.append(h('div', { class: 'actionbar', role: 'region', 'aria-label': 'Acciones sobre la selección' },
      h('strong', {}, `${plural(ids.length, 'equipo seleccionado', 'equipos seleccionados')}`),
      h('button', { class: 'primary', onclick: () => sendMessageDialog(ids, load) }, 'Enviar mensaje'),
      h('button', { class: 'stop', onclick: () => lockDialog(ids, load) }, 'Bloquear'),
      h('button', { onclick: guard(() => bulk(ids, 'unlock', {}, 'Desbloqueo enviado', load)) }, 'Desbloquear'),
      canAdmin() ? h('button', { onclick: () => assignDialog(ids, load) }, 'Cambiar perfil') : null,
      h('button', { onclick: () => assignClientDialog(ids, load) }, 'Asignar cliente'),
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

async function assignClientDialog(ids, after) {
  const clients = await api('GET', '/api/clients');
  if (!clients.length) return toast('Primero cargá un cliente en Clientes', true);
  const sel = h('select', { id: 'acl' }, h('option', { value: '' }, 'Sin cliente'), clients.map((c) => h('option', { value: c.id }, clientLabel(c))));
  const d = dialog(`Asignar cliente a ${plural(ids.length, 'equipo', 'equipos')}`, h('div', {}, h('label', { for: 'acl' }, 'Cliente'), sel), [
    h('button', { onclick: () => d.close() }, 'Cancelar'),
    h('button', { class: 'primary', onclick: guard(async () => {
      await bulk(ids, 'assignClient', { clientId: sel.value ? Number(sel.value) : null }, 'Cliente asignado', after);
      d.close();
    }) }, 'Asignar cliente'),
  ]);
}

// ---- Detalle de un equipo --------------------------------------------------------------------
const STATUS = { pending: ['Esperando al equipo', ''], sent: ['Entregado', ''], done: ['Hecho', 'ok'], failed: ['Falló', 'bad'], expired: ['Venció', 'warn'] };
const COMMAND = { message: 'Mensaje', reboot: 'Reinicio', sync: 'Sincronización', install: 'Instalar app', uninstall: 'Desinstalar app', exitKiosk: 'Salir del kiosko', enterKiosk: 'Activar kiosko', decommission: 'Dar de baja' };
const statusPill = (s) => h('span', { class: `pill ${STATUS[s]?.[1] || ''}` }, STATUS[s]?.[0] || s);

async function openDevice(id, onChange) {
  const admin = canAdmin();
  const staff = canAct();
  const [d, files, profiles, clients] = await Promise.all([api('GET', `/api/devices/${id}`), admin ? api('GET', '/api/files') : [], admin ? api('GET', '/api/profiles') : [], staff ? api('GET', '/api/clients') : []]);
  const s = d.state;
  const refresh = async () => { dlg.close(); await onChange?.(); await openDevice(id, onChange); };
  const name = h('input', { type: 'text', id: 'dn', value: d.name, maxlength: 80 });
  const group = h('input', { type: 'text', id: 'dg', value: d.group, maxlength: 60 });
  const profile = h('select', { id: 'dp' }, profiles.map((p) => h('option', { value: p.id, selected: p.id === d.profileId }, p.name)));
  const notes = h('textarea', { id: 'dnotes', maxlength: 500, value: d.notes });
  const client = h('select', { id: 'dcl' }, h('option', { value: '' }, 'Sin cliente'), clients.map((c) => h('option', { value: c.id, selected: c.id === d.clientId }, clientLabel(c))));
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
      [['Cliente', d.clientId ? `${d.clientName} (ID ${d.clientExtId})` : ''], ['Modelo', `${s.manufacturer || ''} ${s.model || ''}`], ['Android', s.androidVersion ? `${s.androidVersion} (API ${s.sdk})` : ''],
      ['Launcher', s.launcherVersion || ''], ['Red', s.network || ''], ['IP local', s.ip || ''], ['IP pública', d.publicIp], ['MAC', s.mac || ''],
      ['Kiosko', s.kiosk === false ? 'Desactivado' : s.mode === 'compat' ? 'Activo, modo compatible' : (s.lockTask ? 'Activo' : 'Sin confirmar')]].flatMap(([k, v]) => (v ? [h('dt', {}, k), h('dd', {}, v)] : []))),

    staff ? h('h3', {}, 'Acciones') : null,
    staff ? h('div', { class: 'wrap-actions' },
      h('button', { class: 'primary', onclick: () => sendMessageDialog([id], refresh) }, 'Enviar mensaje'),
      d.blocked ? h('button', { onclick: act('unlock', {}, 'Desbloqueo enviado') }, 'Desbloquear') : h('button', { class: 'danger', onclick: () => lockDialog([id], refresh) }, 'Bloquear'),
      admin ? [
      h('button', { onclick: act('sync', {}, 'Sincronización enviada') }, 'Sincronizar'),
      h('button', { onclick: () => confirmDialog('Reiniciar equipo', `¿Reiniciar ${d.name}?`, 'Reiniciar', true, act('reboot', {}, 'Reinicio enviado')) }, 'Reiniciar'),
      s.kiosk === false
        ? h('button', { onclick: act('enterKiosk', {}, 'Activación enviada') }, 'Activar kiosko')
        : h('button', { onclick: () => confirmDialog('Salir del kiosko', `${d.name} va a volver al launcher original y queda sin protección hasta reactivar el kiosko.`, 'Salir del kiosko', true, act('exitKiosk', {}, 'Salida enviada')) }, 'Salir del kiosko'),
      h('button', { class: 'danger', onclick: () => confirmDialog('Dar de baja', `WiFly deja de administrar ${d.name} y el equipo vuelve a su estado original. Para administrarlo otra vez hay que reinstalarlo con el script.`, 'Dar de baja', true, act('decommission', {}, 'Baja enviada')) }, 'Dar de baja')] : null) : null,

    staff ? [h('h3', {}, 'Datos'),
    h('label', { for: 'dn' }, 'Nombre'), name,
    h('label', { for: 'dg' }, 'Grupo'), group,
    h('label', { for: 'dcl' }, 'Cliente'), client,
    admin ? [h('label', { for: 'dp' }, 'Perfil'), profile] : null,
    h('label', { for: 'dnotes' }, 'Notas'), notes,
    h('div', { class: 'save-bar' }, h('button', { class: 'primary', onclick: guard(async () => {
      await api('PATCH', `/api/devices/${id}`, { name: name.value, group: group.value, ...(admin ? { profileId: Number(profile.value) } : {}), notes: notes.value, clientId: client.value ? Number(client.value) : null });
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
  const [sends, audit] = await Promise.all([api('GET', '/api/sends'), canAdmin() || isViewer() ? api('GET', '/api/audit') : null]);
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
  const [tokens, profiles, clients] = await Promise.all([api('GET', '/api/enroll-tokens'), api('GET', '/api/profiles'), api('GET', '/api/clients')]);
  const client = h('select', { id: 't-c' }, h('option', { value: '' }, 'Sin cliente'), clients.map((c) => h('option', { value: c.id }, clientLabel(c))));
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
      h('label', { for: 't-c' }, 'Cliente'), client,
      h('p', { class: 'hint' }, 'Los equipos que se den de alta con este token quedan asignados a este cliente.'),
      h('label', { for: 't-m' }, 'Máximo de equipos (0 = sin límite)'), maxUses,
      h('label', { for: 't-d' }, 'Días de validez (0 = no vence)'), days,
      h('div', { class: 'save-bar' }, h('button', { class: 'primary', onclick: guard(async () => {
        await api('POST', '/api/enroll-tokens', { label: label.value, profileId: Number(profile.value), group: group.value, clientId: client.value ? Number(client.value) : null, maxUses: Number(maxUses.value), days: Number(days.value) });
        go('enroll');
      }) }, 'Crear token'))),
    tokens.map((t) => {
      const expired = t.expiresAt && t.expiresAt < Date.now();
      const full = t.maxUses && t.uses >= t.maxUses;
      return h('div', { class: 'sheet' },
        h('h2', {}, t.label || 'Token sin nombre', ' ', expired ? h('span', { class: 'pill bad' }, 'Vencido') : full ? h('span', { class: 'pill warn' }, 'Agotado') : h('span', { class: 'pill ok' }, 'Activo')),
        h('p', {}, `Perfil ${profiles.find((p) => p.id === t.profileId)?.name || 'sin asignar'}${t.group ? `, grupo ${t.group}` : ''}${t.clientName ? `, cliente ${t.clientName}` : ''}. Usado ${t.uses}${t.maxUses ? ` de ${t.maxUses}` : ''} veces${t.expiresAt ? `. Vence ${dateTime(t.expiresAt)}` : ''}.`),
        h('p', {}, 'Con el TV Box conectado por ADB, corré desde la carpeta de instalación:'),
        h('pre', {}, `./enroll.sh --server ${origin} --token ${t.token}`),
        h('p', { class: 'hint' }, 'En Windows: ', h('code', {}, `enroll.bat ${origin} ${t.token}`)),
        canAdmin() && h('button', { class: 'plain', onclick: () => confirmDialog('Revocar token', 'Los equipos ya registrados siguen funcionando. No se van a poder sumar equipos nuevos con este token.', 'Revocar token', true, guard(async () => { await api('DELETE', `/api/enroll-tokens/${t.token}`); go('enroll'); })) }, 'Revocar token'));
    }));
}

// ---- Cuenta -----------------------------------------------------------------------------------------
async function viewAccount() {
  const data = userFields('me', me);
  const cur = h('input', { type: 'password', id: 'c-c', autocomplete: 'current-password' });
  const nxt = passwordField('c-n', 'Clave nueva');
  fill(
    header('Cuenta'),
    h('div', { class: 'sheet' }, h('p', {}, 'Entraste como ', h('strong', {}, me.username), `, ${me.roleLabel}`, me.company && !isGlobal() ? ` de ${me.company.name}` : '', '.'),
      h('h2', {}, 'Tus datos'),
      me.email ? null : h('div', { class: 'note' }, 'Cargá tu email: sin él no vas a poder recuperar la clave si te la olvidás.'),
      h('div', { class: 'form-grid' }, data.els),
      h('div', { class: 'save-bar' }, h('button', { class: 'primary', onclick: guard(async () => {
        const r = await api('PUT', '/api/me', data.values());
        Object.assign(me, r);
        document.querySelector('.rail-user').textContent = r.displayName;
        toast('Datos guardados');
        go('account');
      }) }, 'Guardar datos'))),
    h('div', { class: 'sheet' },
      h('h2', {}, 'Cambiar clave del panel'),
      h('label', { for: 'c-c' }, 'Clave actual'), cur,
      nxt.el,
      h('div', { class: 'save-bar' }, h('button', { class: 'primary', onclick: guard(async () => {
        await api('POST', '/api/password', { current: cur.value, next: nxt.input.value });
        cur.value = '';
        nxt.input.value = '';
        nxt.input.dispatchEvent(new Event('input'));
        toast('Clave cambiada');
      }) }, 'Cambiar clave'))));
}

// ---- Arranque --------------------------------------------------------------------------------------
if (location.hash.startsWith('#reset=')) showReset(location.hash.slice(7));
else start().catch(() => {});
// El enlace del correo también funciona si el panel ya estaba abierto en esa pestaña.
window.addEventListener('hashchange', () => { if (location.hash.startsWith('#reset=')) showReset(location.hash.slice(7)); });

// ---- Vistas compartidas -------------------------------------------------------------------------

function auditTable(rows) {
  if (!rows.length) return h('p', { class: 'hint' }, 'Sin actividad todavía.');
  return h('div', { class: 'table-wrap' }, h('table', {}, h('tbody', {}, rows.map((a) => h('tr', {},
    h('td', {}, dateTime(a.ts)), a.company !== undefined ? h('td', {}, a.company || 'General') : null,
    h('td', {}, a.actor), h('td', {}, a.action), h('td', {}, a.detail))))));
}

// ---- Usuarios --------------------------------------------------------------------------------------
/** Sin empresa elegida (administrador general): los administradores generales. Con empresa: sus usuarios. */
/**
 * Tabla de usuarios con alta, edición de datos y rol, cambio de clave y baja.
 * `roles`: [valor, nombre, explicación]. `companies`: si se pasa, el operador del sistema elige sus empresas.
 */
function usersSheet(users, { roles, title, intro = '', canCreate = true, manageable, companies = null }) {
  const roleHelp = h('p', { class: 'hint span2' });
  const roleSelect = (id, value, onChange) => {
    const sel = h('select', { id }, roles.map(([v, t]) => h('option', { value: v, selected: v === value }, t)));
    const paint = () => { roleHelp.textContent = roles.find(([v]) => v === sel.value)?.[2] || ''; onChange?.(sel.value); };
    sel.addEventListener('change', paint);
    return { sel, paint };
  };
  /** Casillas de empresas para el operador del sistema. */
  const companyPicker = (chosen = []) => {
    if (!companies) return null;
    const set = new Set(chosen);
    const box = h('div', { class: 'span2' }, h('label', {}, 'Empresas que administra'),
      companies.length ? h('div', { class: 'pick-list' }, companies.map((c) => h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: set.has(c.id), onchange: (e) => { if (e.target.checked) set.add(c.id); else set.delete(c.id); } }), c.name)))
        : h('p', { class: 'hint' }, 'Todavía no hay empresas. Las que cree este operador le quedan asignadas solas.'),
      h('p', { class: 'hint' }, 'Solo ve estas empresas y las que cree él mismo.'));
    return { box, ids: () => [...set] };
  };
  const reset = (u) => {
    const pw = passwordField('rp', 'Clave nueva');
    const d = dialog(`Nueva clave para ${u.displayName || u.username}`, h('div', {}, pw.el,
      h('p', { class: 'hint' }, 'Sus sesiones abiertas se cierran. Pasale la clave por un medio seguro.')), [
      h('button', { onclick: () => d.close() }, 'Cancelar'),
      h('button', { class: 'primary', onclick: guard(async () => { await api('POST', `/api/users/${u.id}/password`, { password: pw.input.value }); d.close(); toast('Clave cambiada'); }) }, 'Cambiar clave'),
    ]);
    pw.input.focus();
  };
  const edit = (u) => {
    const data = userFields('eu', u);
    const picker = companyPicker((u.companies || []).map((c) => c.id));
    const canPickRole = roles.some(([v]) => v === u.role) && roles.length > 1;
    const role = roleSelect('eu-r', u.role, (v) => { if (picker) picker.box.hidden = v !== 'sysoperator'; });
    const d = dialog(`Editar ${u.username}`, h('div', { class: 'form-grid' },
      canPickRole ? [h('div', { class: 'span2' }, h('label', { for: 'eu-r' }, 'Rol'), role.sel), roleHelp] : null,
      picker?.box,
      data.els), [
      h('button', { onclick: () => d.close() }, 'Cancelar'),
      h('button', { class: 'primary', onclick: guard(async () => {
        const body = { ...data.values() };
        if (canPickRole) body.role = role.sel.value;
        if (picker && role.sel.value === 'sysoperator') body.companyIds = picker.ids();
        await api('PATCH', `/api/users/${u.id}`, body);
        d.close();
        toast('Usuario guardado');
        go(current);
      }) }, 'Guardar'),
    ], 'xwide');
    if (canPickRole) role.paint(); else if (picker) picker.box.hidden = u.role !== 'sysoperator';
    data.focus();
  };
  const create = () => {
    const user = field('nu-u', 'Nombre de usuario', { maxlength: 40, autocomplete: 'off' }, { hint: 'Con este entra al panel. Letras, números, punto, guion o @.' });
    const picker = companyPicker();
    const role = roleSelect('nu-r', roles[0][0], (v) => { if (picker) picker.box.hidden = v !== 'sysoperator'; });
    const pw = passwordField('nu-p', 'Clave');
    const data = userFields('nu');
    const d = dialog('Crear usuario', h('div', { class: 'form-grid' },
      user.el,
      h('div', {}, h('label', { for: 'nu-r' }, 'Rol'), role.sel),
      roleHelp,
      picker?.box,
      h('div', { class: 'span2' }, pw.el),
      ...data.els), [
      h('button', { onclick: () => d.close() }, 'Cancelar'),
      h('button', { class: 'primary', onclick: guard(async () => {
        const body = { username: user.input.value, password: pw.input.value, role: role.sel.value, ...data.values() };
        if (picker && role.sel.value === 'sysoperator') body.companyIds = picker.ids();
        await api('POST', '/api/users', body);
        d.close();
        toast(`Usuario ${user.input.value} creado`);
        go(current);
      }) }, 'Crear usuario'),
    ], 'xwide');
    role.paint();
    user.input.focus();
  };
  return h('div', { class: 'sheet' },
    h('div', { class: 'sheet-head' }, h('h2', {}, title), canCreate ? h('button', { class: 'primary', onclick: create }, 'Crear usuario') : null),
    intro ? h('p', {}, intro) : null,
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Usuario', 'Nombre', 'Contacto', 'Rol', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, users.map((u) => h('tr', {},
        h('td', {}, h('strong', {}, u.username), u.username === me.username ? ' (vos)' : ''),
        h('td', {}, u.fullName || h('span', { class: 'hint' }, 'Sin cargar'), u.displayName && u.displayName !== u.fullName ? [h('br'), h('small', {}, `Se muestra como ${u.displayName}`)] : null),
        h('td', {}, u.email || h('span', { class: 'hint' }, 'Sin email'), u.phone ? [h('br'), h('small', {}, u.phone)] : null),
        h('td', {}, u.roleLabel.charAt(0).toUpperCase() + u.roleLabel.slice(1),
          u.companies ? [h('br'), h('small', {}, u.companies.length ? u.companies.map((c) => c.name).join(', ') : 'Sin empresas asignadas')] : null),
        h('td', {}, u.username !== me.username && manageable(u) ? h('div', { class: 'row-actions' },
          h('button', { onclick: () => edit(u) }, 'Editar'),
          h('button', { onclick: () => reset(u) }, 'Cambiar clave'),
          h('button', { class: 'danger', onclick: () => confirmDialog('Eliminar usuario', `${u.username} ya no va a poder entrar al panel.`, 'Eliminar usuario', true, guard(async () => { await api('DELETE', `/api/users/${u.id}`); go(current); })) }, 'Eliminar')) : null)))))));
}

const COMPANY_ROLES = [
  ['admin', 'Administrador de la empresa', 'Maneja todo en la empresa: equipos, clientes, perfiles, apps, altas, usuarios y respaldos.'],
  ['operator', 'Operador de la empresa', 'Agrega clientes y equipos, y les envía mensajes, los bloquea y desbloquea. No borra nada ni toca perfiles ni apps.'],
];

async function viewUsers() {
  const users = await api('GET', '/api/users');
  const admin = canAdmin();
  fill(header('Usuarios'), usersSheet(users, {
    roles: COMPANY_ROLES, title: `Usuarios de ${me.company.name}`, canCreate: admin,
    intro: admin ? '' : 'Solo lectura.', manageable: () => admin,
  }));
}

const SYSTEM_ROLES = [
  ['sysadmin', 'Administrador del sistema', 'Puede modificar todo en el sistema: empresas, facturación, configuración, respaldos, actualizaciones y usuarios.'],
  ['sysoperator', 'Operador del sistema', 'Agrega empresas pero no las borra. Solo ve y administra las empresas que tiene asignadas y las que crea.'],
  ['billing', 'Facturación', 'Ve todo sin modificar nada. Puede suspender y reactivar empresas por falta de pago, y exportar la facturación a Excel.'],
];

async function viewSystemUsers() {
  const [users, companies] = await Promise.all([api('GET', '/api/users?scope=system'), api('GET', '/api/companies')]);
  const roles = isSuper() ? SYSTEM_ROLES : SYSTEM_ROLES.filter(([v]) => v !== 'sysadmin');
  fill(header('Usuarios del sistema'), usersSheet(users, {
    roles, title: 'Usuarios del sistema', companies: companies.map((c) => ({ id: c.id, name: c.name })),
    intro: `El rol de administrador general es único y lo tiene ${users.find((u) => u.role === 'superadmin')?.username || 'el usuario principal'}.${isSuper() ? '' : ' Los administradores del sistema los crea el administrador general.'} Los usuarios de cada empresa se crean adentro de la empresa, en su sección Usuarios.`,
    manageable: (u) => (u.role === 'superadmin' || u.role === 'sysadmin' ? isSuper() : true),
  }));
}


// ---- Clientes ---------------------------------------------------------------------------------------
let clientSearch = '';

async function viewClients() {
  const clients = await api('GET', '/api/clients');
  const box = h('div');
  const total = clients.reduce((n, c) => n + c.devices, 0);
  const paint = () => {
    const t = clientSearch.toLowerCase();
    const list = clients.filter((c) => !t || `${c.extId} ${c.name} ${c.phone} ${c.taxId} ${c.email}`.toLowerCase().includes(t));
    if (!clients.length) {
      box.replaceChildren(h('div', { class: 'empty' }, h('h2', {}, 'Todavía no hay clientes'),
        h('p', {}, 'Cargá a quienes les instalás los TV Box. Después asignales sus equipos para encontrarlos, avisarles o bloquearlos juntos.'),
        canAct() ? h('button', { class: 'primary', onclick: () => clientDialog(null) }, 'Crear cliente') : null));
      return;
    }
    box.replaceChildren(list.length ? h('div', { class: 'sheet' }, h('div', { class: 'table-wrap' }, h('table', { class: 'clients' },
      h('thead', {}, h('tr', {}, h('th', {}, 'ID'), h('th', {}, 'Cliente'), h('th', {}, 'Teléfono'), h('th', { class: 'num' }, 'Equipos'))),
      h('tbody', {}, list.map((c) => h('tr', { onclick: () => openClient(c.id) },
        h('td', { class: 'id' }, c.extId),
        h('td', {}, h('button', { class: 'link-button', onclick: (e) => { e.stopPropagation(); openClient(c.id); } }, c.name)),
        h('td', {}, c.phone || h('span', { class: 'hint' }, '—')),
        h('td', { class: 'num' }, c.devices, c.blocked ? [h('br'), h('small', { class: 'err-line' }, `${c.blocked} bloqueado${c.blocked === 1 ? '' : 's'}`)] : null)))))))
      : h('div', { class: 'empty' }, h('p', {}, 'Ningún cliente coincide con la búsqueda.')));
  };
  fill(
    header('Clientes', h('span', { class: 'count' }, clients.length ? `${plural(clients.length, 'cliente', 'clientes')}, ${plural(total, 'equipo asignado', 'equipos asignados')}` : ''),
      h('span', { class: 'spacer' }), canAct() && clients.length ? h('button', { class: 'primary', onclick: () => clientDialog(null) }, 'Crear cliente') : null),
    clients.length ? h('div', { class: 'filters' }, h('input', { type: 'search', placeholder: 'Buscar por ID, nombre, teléfono o documento', 'aria-label': 'Buscar cliente', value: clientSearch, oninput: (e) => { clientSearch = e.target.value; paint(); } })) : null,
    box);
  paint();
}

function clientDialog(c, after) {
  const f = {
    extId: field('cl-id', 'ID del cliente', { value: c?.extId || '', maxlength: 40, autocomplete: 'off' }, { hint: 'El mismo que usás en tu sistema de gestión. Sirve para vincularlo por API.' }),
    name: field('cl-n', 'Nombre completo', { value: c?.name || '', maxlength: 120, autocomplete: 'off' }),
    taxId: field('cl-t', 'DNI, CUIT o CUIL', { value: c?.taxId || '', maxlength: 20, inputmode: 'numeric', autocomplete: 'off' }),
    phone: field('cl-p', 'Teléfono', { type: 'tel', value: c?.phone || '', maxlength: 30, autocomplete: 'off' }),
    address: field('cl-a', 'Domicilio', { value: c?.address || '', maxlength: 200, autocomplete: 'off' }, { span: true }),
    email: field('cl-e', 'Email', { type: 'email', value: c?.email || '', maxlength: 120, autocomplete: 'off' }, { span: true }),
    notes: field('cl-o', 'Notas', { value: c?.notes || '', maxlength: 500 }, { span: true, el: 'textarea' }),
  };
  const d = dialog(c ? `Editar ${c.name}` : 'Crear cliente', h('div', { class: 'form-grid' }, Object.values(f).map((x) => x.el)), [
    h('button', { onclick: () => d.close() }, 'Cancelar'),
    h('button', { class: 'primary', onclick: guard(async () => {
      const body = Object.fromEntries(Object.entries(f).map(([k, x]) => [k, x.input.value]));
      const r = await api(c ? 'PUT' : 'POST', c ? `/api/clients/${c.id}` : '/api/clients', body);
      d.close();
      toast(c ? 'Cliente guardado' : `Cliente ${r.extId} creado`);
      if (after) await after(r); else go('clients');
    }) }, c ? 'Guardar cliente' : 'Crear cliente'),
  ], 'xwide');
  f.extId.input.focus();
}

async function openClient(id) {
  const c = await api('GET', `/api/clients/${id}`);
  const admin = canAdmin();
  const staff = canAct();
  const chosen = new Set();
  const reopen = async () => { dlg.close(); if (current === 'clients') await viewClients(); await openClient(id); };
  const ids = () => (chosen.size ? [...chosen] : c.deviceList.map((d) => d.id));
  const target = () => (chosen.size ? plural(chosen.size, 'equipo elegido', 'equipos elegidos') : 'todos sus equipos');
  const actions = h('div', { class: 'wrap-actions' });
  const paintActions = () => actions.replaceChildren(...(!staff ? [] : [
    h('button', { class: 'primary', disabled: !c.deviceList.length, onclick: () => sendMessageDialog(ids(), reopen) }, 'Enviar mensaje'),
    h('button', { class: 'danger', disabled: !c.deviceList.length, onclick: () => lockDialog(ids(), reopen) }, 'Bloquear'),
    h('button', { disabled: !c.deviceList.length, onclick: guard(() => bulk(ids(), 'unlock', {}, 'Desbloqueo enviado', reopen)) }, 'Desbloquear'),
    h('button', { onclick: () => addDevicesDialog(c, reopen) }, 'Agregar equipos'),
    chosen.size ? h('button', { onclick: guard(() => bulk([...chosen], 'assignClient', { clientId: null }, 'Equipos quitados del cliente', reopen)) }, 'Quitar del cliente') : null,
    h('p', { class: 'hint' }, `Las acciones se aplican a ${target()}.`),
  ].filter(Boolean)));
  paintActions();
  const rows = c.deviceList.map((d) => h('tr', {},
    h('td', {}, staff && h('input', { type: 'checkbox', 'aria-label': `Elegir ${d.name}`, onchange: (e) => { if (e.target.checked) chosen.add(d.id); else chosen.delete(d.id); paintActions(); } })),
    h('td', {}, h('strong', {}, d.name), h('br'), h('small', {}, d.state.model || '')),
    h('td', {}, d.suspended ? [h('span', { class: 'dot bad' }), 'Suspendido'] : d.blocked ? [h('span', { class: 'dot bad' }), 'Bloqueado'] : d.online ? [h('span', { class: 'dot on' }), 'En línea'] : [h('span', { class: 'dot' }), `Visto ${ago(d.lastSeen)}`]),
    h('td', {}, h('button', { class: 'plain', onclick: () => openDevice(d.id, reopen) }, 'Ver'))));
  const facts = [['ID', c.extId], ['DNI/CUIT/CUIL', c.taxId], ['Domicilio', c.address], ['Teléfono', c.phone], ['Email', c.email], ['Notas', c.notes]];
  const dlg = h('dialog', { class: 'drawer' },
    h('div', { class: 'drawer-head' }, h('h2', {}, c.name), h('button', { onclick: () => dlg.close() }, 'Cerrar')),
    h('dl', { class: 'facts' }, facts.flatMap(([k, v]) => (v ? [h('dt', {}, k), h('dd', {}, v)] : []))),
    staff ? h('div', { class: 'wrap-actions' },
      h('button', { onclick: () => clientDialog(c, async () => reopen()) }, 'Editar datos'),
      admin && h('button', { class: 'danger', onclick: () => confirmDialog(`Eliminar ${c.name}`, `Se borra el cliente. ${c.devices ? `Sus ${plural(c.devices, 'equipo', 'equipos')} siguen funcionando, sin cliente asignado.` : ''}`, 'Eliminar cliente', true, guard(async () => { await api('DELETE', `/api/clients/${c.id}`); dlg.close(); go('clients'); })) }, 'Eliminar cliente')) : null,
    h('h3', {}, `Equipos (${c.deviceList.length})`, c.online ? `, ${c.online} en línea` : ''),
    c.deviceList.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'devices' }, h('tbody', {}, rows))) : h('p', { class: 'hint' }, staff ? 'Este cliente no tiene equipos. Agregalos acá, desde Pantallas o al crear un token de alta.' : 'Este cliente no tiene equipos asignados.'),
    actions);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

async function addDevicesDialog(c, after) {
  const all = await api('GET', '/api/devices');
  const others = all.filter((d) => d.clientId !== c.id);
  if (!others.length) return toast('Todos los equipos ya son de este cliente', true);
  const pick = new Set();
  const search = h('input', { type: 'search', placeholder: 'Buscar equipo', 'aria-label': 'Buscar equipo' });
  const list = h('div', { class: 'pick-list' });
  const paint = () => {
    const t = search.value.toLowerCase();
    list.replaceChildren(...others.filter((d) => !t || `${d.name} ${d.group} ${d.state.model || ''} ${d.clientName}`.toLowerCase().includes(t)).map((d) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: pick.has(d.id), onchange: (e) => { if (e.target.checked) pick.add(d.id); else pick.delete(d.id); } }),
      h('span', {}, d.name, ' ', h('small', {}, d.clientId ? `ahora de ${d.clientName}` : 'sin cliente', d.group ? `, grupo ${d.group}` : '')))));
  };
  search.addEventListener('input', paint);
  paint();
  const d = dialog(`Agregar equipos a ${c.name}`, h('div', {}, search, list), [
    h('button', { onclick: () => d.close() }, 'Cancelar'),
    h('button', { class: 'primary', onclick: guard(async () => {
      if (!pick.size) throw new Error('Elegí al menos un equipo');
      await bulk([...pick], 'assignClient', { clientId: c.id }, 'Equipos agregados');
      d.close();
      await after();
    }) }, 'Agregar equipos'),
  ], 'wide');
  search.focus();
}

// ---- Empresas (administrador general) ------------------------------------------------------------
const dayDate = (ts) => new Date(ts).toLocaleDateString('es-AR', { dateStyle: 'medium' });
function companyState(c) {
  if (c.status === 'active') return h('span', { class: 'pill ok' }, 'Activa');
  if (c.devicesSuspended) return h('span', { class: 'pill bad' }, 'Suspendida, TV Box bloqueados');
  return [h('span', { class: 'pill warn' }, 'Panel suspendido'), h('br'), h('small', {}, `TV Box se bloquean el ${dayDate(c.devicesSuspendAt)}`)];
}

async function viewCompanies() {
  const companies = await api('GET', '/api/companies');
  const settings = { graceDays: me.graceDays };
  const total = companies.reduce((n, c) => n + c.monthDevices, 0);
  const rows = companies.map((c) => h('tr', {},
    h('td', {}, h('strong', {}, c.name),
      c.legalName ? [h('br'), h('small', {}, `${c.legalName}${c.taxId ? `, ${c.taxId}` : ''}`)] : [h('br'), h('small', { class: 'err-line' }, 'Faltan los datos fiscales')],
      c.notes ? [h('br'), h('small', { class: 'hint' }, c.notes)] : null),
    h('td', {}, companyState(c)),
    h('td', { class: 'num' }, c.devices), h('td', { class: 'num' }, c.online), h('td', { class: 'num' }, c.monthDevices),
    h('td', {}, c.admins.join(', ') || h('span', { class: 'hint' }, 'Sin administrador')),
    h('td', {}, h('div', { class: 'row-actions' },
      h('button', { class: 'primary', onclick: guard(() => setContext(c.id)) }, perm('companiesEdit') || perm('companiesDelete') ? 'Administrar' : 'Ver'),
      !perm('companiesSuspend') ? null : c.status === 'active'
        ? h('button', { class: 'danger', onclick: () => confirmDialog(`Suspender ${c.name}`, `El panel de ${c.name} se corta ahora. Si no se registra el pago en ${settings.graceDays} días, sus TV Box muestran "Servicio suspendido".`, 'Suspender', true, guard(async () => { await api('POST', `/api/companies/${c.id}/suspend`, {}); toast(`${c.name} suspendida`); go('companies'); })) }, 'Suspender')
        : h('button', { onclick: guard(async () => { await api('POST', `/api/companies/${c.id}/activate`, {}); toast(`Pago registrado: ${c.name} reactivada`); go('companies'); }) }, 'Marcar pagada'),
      perm('companiesEdit') ? h('button', { onclick: () => editCompany(c) }, 'Editar') : null,
      c.devices === 0 && perm('companiesDelete') ? h('button', { class: 'plain', onclick: () => confirmDialog(`Eliminar ${c.name}`, 'Se borran la empresa, sus usuarios, perfiles y archivos. No se puede deshacer.', 'Eliminar empresa', true, guard(async () => { await api('DELETE', `/api/companies/${c.id}`); go('companies'); })) }, 'Eliminar') : null))));
  fill(
    header('Empresas', h('span', { class: 'count' }, companies.length ? `${plural(companies.length, 'empresa', 'empresas')}, ${plural(total, 'equipo facturable', 'equipos facturables')} este mes` : ''),
      h('span', { class: 'spacer' }), perm('companiesCreate') ? h('button', { class: 'primary', onclick: newCompany }, 'Crear empresa') : null),
    companies.length
      ? h('div', { class: 'sheet' }, h('div', { class: 'table-wrap' }, h('table', { class: 'companies' },
        h('thead', {}, h('tr', {}, ['Empresa', 'Estado', 'Equipos', 'En línea', 'Facturables este mes', 'Administradores', ''].map((t, i) => h('th', { class: i >= 2 && i <= 4 ? 'num' : null }, t)))),
        h('tbody', {}, rows))))
      : h('div', { class: 'empty' }, h('h2', {}, perm('companiesAll') ? 'Todavía no hay empresas' : 'No tenés empresas asignadas'),
        h('p', {}, perm('companiesCreate') ? 'Creá una empresa con su administrador. Él va a poder cargar sus equipos, perfiles y apps.' : 'Pedile al administrador que te asigne las empresas que vas a manejar.'),
        perm('companiesCreate') ? h('button', { class: 'primary', onclick: newCompany }, 'Crear empresa') : null));
}

function newCompany() {
  const co = companyFields();
  const user = field('nc-u', 'Nombre de usuario', { maxlength: 40, autocomplete: 'off' });
  const pw = passwordField('nc-p', 'Clave');
  const data = userFields('nc', {}, { emailRequired: false, emailHint: 'Vacío: el email de contacto de la empresa. Con él recupera la clave.' });
  const d = dialog('Crear empresa', h('div', { class: 'form-grid' },
    h('h3', {}, 'Empresa'), co.els,
    h('h3', {}, 'Administrador de la empresa'),
    user.el, h('div'),
    h('div', { class: 'span2' }, pw.el),
    data.els,
    h('p', { class: 'hint span2' }, 'Si dejás vacío el usuario, la empresa se crea sin administrador y lo agregás después desde Usuarios, administrando la empresa.')), [
    h('button', { onclick: () => d.close() }, 'Cancelar'),
    h('button', { class: 'primary', onclick: guard(async () => {
      const c = co.values();
      const admin = user.input.value.trim() ? { username: user.input.value, password: pw.input.value, ...data.values() } : undefined;
      await api('POST', '/api/companies', { ...c, admin });
      d.close();
      toast(`${c.name} creada`);
      go('companies');
    }) }, 'Crear empresa'),
  ], 'xwide');
  co.focus();
}

function editCompany(c) {
  const co = companyFields(c);
  const notes = h('textarea', { id: 'ec-o', maxlength: 500, value: c.notes });
  const d = dialog(`Editar ${c.name}`, h('div', { class: 'form-grid' }, co.els,
    h('div', { class: 'span2' }, h('label', { for: 'ec-o' }, 'Notas internas'), notes, h('p', { class: 'hint' }, 'Solo las ven los administradores generales.'))), [
    h('button', { onclick: () => d.close() }, 'Cancelar'),
    h('button', { class: 'primary', onclick: guard(async () => {
      await api('PATCH', `/api/companies/${c.id}`, { ...co.values(), notes: notes.value });
      d.close();
      toast('Empresa guardada');
      go('companies');
    }) }, 'Guardar cambios'),
  ], 'xwide');
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
      h('thead', {}, h('tr', {}, h('th', {}, 'Empresa'), h('th', {}, 'Datos fiscales'), h('th', {}, 'Estado'), h('th', { class: 'num' }, 'Equipos facturables'), h('th', {}, ''))),
      h('tbody', {}, r.rows.map((x) => h('tr', {}, h('td', {}, x.name), h('td', {}, x.legalName ? [x.legalName, h('br'), h('small', {}, [x.taxId, x.taxCondition].filter(Boolean).join(', '))] : h('span', { class: 'hint' }, 'Sin cargar')),
        h('td', {}, statusText[x.status] || x.status), h('td', { class: 'num' }, x.devices),
        h('td', {}, x.devices ? h('a', { href: `/api/billing/${x.companyId}/devices.csv?month=${r.month}`, download: '' }, 'Detalle por equipo') : null))),
      h('tr', { class: 'total' }, h('td', {}, 'Total'), h('td', {}), h('td', {}), h('td', { class: 'num' }, r.total), h('td', {})))))));
}

// ---- Configuración general ------------------------------------------------------------------------
async function viewSettings() {
  const [settings, audit] = await Promise.all([api('GET', '/api/settings'), api('GET', '/api/audit')]);
  const gid = h('input', { type: 'text', id: 's-gid', value: settings.googleClientId, placeholder: '123456-abc.apps.googleusercontent.com', autocomplete: 'off' });
  const gsecret = h('input', { type: 'password', id: 's-gsec', autocomplete: 'new-password', placeholder: settings.googleSecretSet ? 'Guardado. Dejalo vacío para no cambiarlo' : '' });
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
    h('div', { class: 'sheet' }, h('h2', {}, 'Aplicación de Google Drive'),
      h('p', {}, 'Para que los respaldos se guarden en Google Drive, WiFly necesita una aplicación de Google propia. Se crea una sola vez en Google Cloud; los pasos están en la guía, sección "Respaldos".'),
      h('label', {}, 'Dirección de retorno autorizada (copiala en Google Cloud)'), h('pre', {}, settings.googleRedirectUri),
      h('label', { for: 's-gid' }, 'ID de cliente'), gid,
      h('label', { for: 's-gsec' }, 'Secreto de cliente'), gsecret,
      h('p', { class: 'hint' }, 'WiFly pide solo permiso para los archivos que crea él mismo: no puede ver el resto del Drive.'),
      h('div', { class: 'save-bar' }, h('button', { class: 'primary', onclick: guard(async () => {
        await api('PUT', '/api/settings', { brandPhrase: phrase.value, graceDays: Number(grace.value), googleClientId: gid.value, googleClientSecret: gsecret.value });
        gsecret.value = '';
        toast('Aplicación de Google guardada');
      }) }, 'Guardar aplicación de Google'))),
    mailSheet(settings),
    h('div', { class: 'sheet' }, h('h2', {}, 'Actividad general'), auditTable(audit)));
}

/** Correo saliente: lo usa la recuperación de claves. */
function mailSheet(st) {
  const host = field('m-h', 'Servidor SMTP', { value: st.smtpHost, placeholder: 'smtp.gmail.com', autocomplete: 'off' });
  const port = field('m-p', 'Puerto', { type: 'number', min: 1, max: 65535, value: st.smtpPort || 587 });
  const sec = h('select', { id: 'm-s' }, [['starttls', 'STARTTLS (puerto 587)'], ['tls', 'TLS directo (puerto 465)']].map(([v, t]) => h('option', { value: v, selected: st.smtpSecurity === v }, t)));
  sec.addEventListener('change', () => { port.input.value = sec.value === 'tls' ? 465 : 587; });
  const user = field('m-u', 'Usuario', { value: st.smtpUser, autocomplete: 'off' });
  const pass = field('m-pw', 'Contraseña', { type: 'password', autocomplete: 'new-password', placeholder: st.smtpPassSet ? 'Guardada. Dejala vacía para no cambiarla' : '' });
  const from = field('m-f', 'Remitente', { value: st.smtpFrom, placeholder: 'WiFly MDM <avisos@miempresa.com>' }, { span: true, hint: 'Conviene que sea una dirección del mismo dominio que la cuenta SMTP, para que no caiga en spam.' });
  const values = () => ({ smtpHost: host.input.value, smtpPort: Number(port.input.value), smtpSecurity: sec.value, smtpUser: user.input.value, smtpPass: pass.input.value, smtpFrom: from.input.value });
  return h('div', { class: 'sheet' }, h('h2', {}, 'Correo saliente'),
    h('p', {}, 'Con esto, cualquier usuario del panel puede recuperar su clave por email desde "Olvidé mi clave". Sirve una cuenta de correo de tu dominio o de Gmail con una contraseña de aplicación.'),
    st.mailReady ? null : h('div', { class: 'note' }, 'Sin configurar: la recuperación de claves por email no funciona. Mientras tanto, un administrador puede cambiar la clave de otro usuario desde Usuarios.'),
    h('div', { class: 'form-grid' },
      host.el, h('div', {}, h('label', { for: 'm-s' }, 'Seguridad'), sec),
      port.el, h('div'),
      user.el, pass.el, from.el),
    h('div', { class: 'save-bar' },
      h('button', { class: 'primary', onclick: guard(async () => {
        const g = await api('GET', '/api/settings');
        await api('PUT', '/api/settings', { brandPhrase: g.brandPhrase, graceDays: g.graceDays, ...values() });
        pass.input.value = '';
        toast('Correo saliente guardado');
      }) }, 'Guardar correo'),
      h('button', { onclick: guard(async () => {
        toast('Enviando prueba…');
        const r = await api('POST', '/api/settings/mail-test', {});
        toast(`Correo de prueba enviado a ${r.to}`);
      }) }, me.email ? `Enviar prueba a ${me.email}` : 'Enviar prueba')));
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

// ---- Respaldos --------------------------------------------------------------------------------------
const WEEKDAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const RUN_STATE = { running: ['En curso', 'warn'], ok: ['Correcto', 'ok'], partial: ['Incompleto', 'warn'], error: ['Falló', 'bad'] };
const DEST_HELP = {
  sftp: 'Un servidor o NAS con acceso SSH. La primera conexión guarda su huella y después solo acepta ese mismo servidor.',
  ftps: 'Un hosting o NAS con FTP sobre TLS (FTPS explícito). El FTP sin cifrar no se permite.',
  gdrive: 'Una cuenta de Google. WiFly crea su propia carpeta y no ve el resto del Drive.',
};

async function viewBackups(scope) {
  const general = scope === 'general';
  let s = await api('GET', `/api/backups/${scope}`);
  let timer = null;
  const prevStop = stopTimer;
  stopTimer = () => { clearTimeout(timer); prevStop(); };
  const poll = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!$main.isConnected || current !== (general ? 'backups' : 'cbackups')) return;
      s = await api('GET', `/api/backups/${scope}`).catch(() => s);
      paint();
      if (s.running) poll();
    }, 2500);
  };

  // Se guarda la configuración entera; las claves vacías se conservan en el servidor.
  const saveAll = async (patch = {}) => {
    s = await api('PUT', `/api/backups/${scope}`, {
      enabled: s.enabled, frequency: s.frequency, weekday: s.weekday, hour: s.hour, keep: s.keep, password: '',
      destinations: s.destinations.map((d) => ({ id: d.id, type: d.type, name: d.name, config: { ...d.config } })), ...patch,
    });
    paint();
  };

  function scheduleSheet() {
    const enabled = h('input', { type: 'checkbox', checked: s.enabled });
    const freq = h('select', { id: 'b-f', onchange: () => { wd.hidden = freq.value !== 'weekly'; } },
      [['daily', 'Todos los días'], ['weekly', 'Una vez por semana'], ['manual', 'Solo cuando toque "Respaldar ahora"']].map(([v, t]) => h('option', { value: v, selected: s.frequency === v }, t)));
    const day = h('select', { id: 'b-d' }, WEEKDAYS.map((t, i) => h('option', { value: i, selected: s.weekday === i }, t)));
    const wd = h('div', { hidden: s.frequency !== 'weekly' }, h('label', { for: 'b-d' }, 'Día'), day);
    const hour = h('select', { id: 'b-h' }, Array.from({ length: 24 }, (_, i) => h('option', { value: i, selected: s.hour === i }, `${String(i).padStart(2, '0')}:00`)));
    const keep = h('input', { type: 'number', id: 'b-k', min: 1, max: 365, value: s.keep });
    const pass = h('input', { type: 'password', id: 'b-p', autocomplete: 'new-password', placeholder: s.passwordSet ? 'Guardada. Dejala vacía para no cambiarla' : '10 caracteres o más' });
    return h('div', { class: 'sheet' }, h('h2', {}, 'Programación'),
      h('label', { class: 'check' }, enabled, 'Hacer respaldos automáticos'),
      h('label', { for: 'b-f' }, 'Frecuencia'), freq, wd,
      h('label', { for: 'b-h' }, 'Hora'), hour,
      h('label', { for: 'b-k' }, 'Copias a guardar en cada destino'), keep,
      h('p', { class: 'hint' }, 'Al llegar a esa cantidad, se borra la más vieja.'),
      h('label', { for: 'b-p' }, 'Contraseña de cifrado'), pass,
      h('p', { class: 'hint' }, 'Cifra cada respaldo. Guardala en un lugar seguro: sin ella no se puede restaurar, ni siquiera nosotros.'),
      h('div', { class: 'save-bar' }, h('button', { class: 'primary', onclick: guard(async () => {
        await saveAll({ enabled: enabled.checked, frequency: freq.value, weekday: Number(day.value), hour: Number(hour.value), keep: Number(keep.value), password: pass.value });
        toast('Programación guardada');
      }) }, 'Guardar programación')));
  }

  function destDialog(existing) {
    const type = h('select', { id: 'd-t', disabled: !!existing }, Object.entries({ sftp: 'SFTP', ftps: 'FTPS', gdrive: 'Google Drive' }).map(([v, t]) => h('option', { value: v, selected: existing?.type === v }, t)));
    const fields = h('div');
    const c = existing?.config || {};
    const inp = {};
    const paintFields = () => {
      const t = type.value;
      const mk = (k, label, props = {}) => { inp[k] = h('input', { id: `d-${k}`, type: 'text', value: c[k] ?? '', autocomplete: 'off', ...props }); return [h('label', { for: `d-${k}` }, label), inp[k]]; };
      inp.name = h('input', { id: 'd-name', type: 'text', maxlength: 60, value: existing?.name || '' , placeholder: t === 'gdrive' ? 'Drive de la empresa' : 'NAS de la oficina' });
      fields.replaceChildren(...[
        h('p', { class: 'hint' }, DEST_HELP[t]),
        h('label', { for: 'd-name' }, 'Nombre para reconocerlo'), inp.name,
        ...(t === 'gdrive' ? [h('p', {}, 'Después de guardar, tocá "Conectar con Google" para elegir la cuenta.')] : [
          ...mk('host', 'Servidor (nombre o IP)', { placeholder: 'nas.miempresa.com' }),
          ...mk('port', 'Puerto', { type: 'number', value: c.port || (t === 'sftp' ? 22 : 21) }),
          ...mk('username', 'Usuario'),
          ...mk('password', 'Contraseña', { type: 'password', value: '', autocomplete: 'new-password', placeholder: c.passwordSet ? 'Guardada. Dejala vacía para no cambiarla' : '' }),
          ...mk('dir', 'Carpeta en el servidor', { placeholder: 'respaldos/wifly' }),
          t === 'ftps' ? h('label', { class: 'check' }, (inp.allowSelfSigned = h('input', { type: 'checkbox', checked: !!c.allowSelfSigned })), 'Aceptar certificado propio (solo si confiás en ese servidor)') : null,
          t === 'sftp' && c.fingerprint ? h('label', { class: 'check' }, (inp.resetFingerprint = h('input', { type: 'checkbox' })), `Olvidar la huella guardada (${c.fingerprint})`) : null,
        ]),
      ].filter(Boolean));
    };
    paintFields();
    type.addEventListener('change', paintFields);
    const d = dialog(existing ? `Editar ${existing.name}` : 'Agregar destino', h('div', {}, h('label', { for: 'd-t' }, 'Tipo'), type, fields), [
      h('button', { onclick: () => d.close() }, 'Cancelar'),
      h('button', { class: 'primary', onclick: guard(async () => {
        const t = type.value;
        const config = {};
        for (const k of ['host', 'port', 'username', 'password', 'dir']) if (inp[k]) config[k] = inp[k].value;
        if (inp.allowSelfSigned) config.allowSelfSigned = inp.allowSelfSigned.checked;
        if (inp.resetFingerprint?.checked) config.resetFingerprint = true;
        const entry = { id: existing?.id, type: t, name: inp.name.value, config };
        const list = s.destinations.map((x) => ({ id: x.id, type: x.type, name: x.name, config: { ...x.config } }));
        if (existing) list[list.findIndex((x) => x.id === existing.id)] = entry; else list.push(entry);
        await saveAll({ destinations: list });
        d.close();
        toast(existing ? 'Destino guardado' : (t === 'gdrive' ? 'Destino agregado. Ahora tocá "Conectar con Google".' : 'Destino agregado. Probá la conexión.'));
      }) }, existing ? 'Guardar destino' : 'Agregar destino'),
    ], 'wide');
  }

  function destDetail(d) {
    if (d.type === 'gdrive') return d.config.email ? `Cuenta ${d.config.email}` : 'Sin conectar';
    return `${d.config.username}@${d.config.host}:${d.config.port}${d.config.dir ? ` / ${d.config.dir}` : ''}`;
  }

  function destSheet() {
    const rows = s.destinations.map((d) => h('tr', {},
      h('td', {}, h('strong', {}, d.name), h('br'), h('small', {}, d.typeLabel, ' · ', destDetail(d))),
      h('td', {}, d.lastResult ? [h('span', { class: `pill ${d.lastResult.ok ? 'ok' : 'bad'}` }, d.lastResult.ok ? 'Bien' : 'Error'), h('br'), h('small', {}, d.lastResult.message)] : h('span', { class: 'hint' }, 'Sin probar')),
      h('td', {}, h('div', { class: 'row-actions' },
        d.type === 'gdrive' ? h('button', { class: d.config.email ? '' : 'primary', disabled: !s.googleReady, title: s.googleReady ? '' : 'Falta configurar la aplicación de Google', onclick: guard(async () => {
          location.href = (await api('GET', `/api/backups/${scope}/google/start/${d.id}`)).url;
        }) }, d.config.email ? 'Cambiar cuenta' : 'Conectar con Google') : null,
        h('button', { onclick: guard(async () => {
          toast('Probando conexión…');
          try { await api('POST', `/api/backups/${scope}/test/${d.id}`, {}); toast('Conexión correcta'); } finally { s = await api('GET', `/api/backups/${scope}`); paint(); }
        }) }, 'Probar'),
        h('button', { onclick: () => destDialog(d) }, 'Editar'),
        h('button', { class: 'plain', onclick: () => confirmDialog('Quitar destino', `Se deja de respaldar en ${d.name}. Los respaldos que ya están ahí no se borran.`, 'Quitar destino', true, () => saveAll({ destinations: s.destinations.filter((x) => x.id !== d.id).map((x) => ({ id: x.id, type: x.type, name: x.name, config: { ...x.config } })) })) }, 'Quitar')))));
    return h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, 'Destinos'), h('button', { onclick: () => destDialog(null) }, 'Agregar destino')),
      !s.googleReady && s.destinations.some((d) => d.type === 'gdrive') ? h('div', { class: 'note' }, perm('settings') ? 'Falta cargar la aplicación de Google en Configuración para conectar Google Drive.' : 'El administrador general todavía no configuró la aplicación de Google. Pedíselo para poder conectar Google Drive.') : null,
      rows.length ? h('div', { class: 'table-wrap' }, h('table', {}, h('tbody', {}, rows))) : h('p', { class: 'hint' }, 'Agregá dónde guardar los respaldos: un servidor SFTP, uno FTPS o Google Drive. Conviene tener dos, en lugares distintos.'));
  }

  function historySheet() {
    if (!s.runs.length) return h('div', { class: 'sheet' }, h('h2', {}, 'Historial'), h('p', { class: 'hint' }, 'Todavía no se hizo ningún respaldo.'));
    return h('div', { class: 'sheet' }, h('h2', {}, 'Historial'), h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Fecha', 'Origen', 'Estado', 'Tamaño', 'Detalle'].map((t) => h('th', {}, t)))),
      h('tbody', {}, s.runs.map((r) => {
        const [label, tone] = RUN_STATE[r.status] || [r.status, ''];
        return h('tr', {}, h('td', {}, dateTime(r.startedAt)), h('td', {}, r.trigger === 'programado' ? 'Programado' : `Manual, ${r.actor}`),
          h('td', {}, h('span', { class: `pill ${tone}` }, label)), h('td', {}, r.size ? sizeOf(r.size) : ''),
          h('td', {}, r.error ? h('div', {}, r.error) : null, r.results.map((x) => h('div', { class: x.ok ? '' : 'err-line' }, `${x.name}: ${x.ok ? 'subido' : x.error}${x.deleted?.length ? ` (borradas ${x.deleted.length} viejas)` : ''}`))));
      })))));
  }

  function restoreDialog(source) {
    const pass = h('input', { type: 'password', id: 'r-p', autocomplete: 'off' });
    const text = general
      ? 'Todo el sistema vuelve al momento de este respaldo: empresas, usuarios, equipos y configuración. Lo que se cambió después se pierde. El servidor se reinicia y el panel se desconecta un momento. Antes se guarda una copia del estado actual en el servidor.'
      : `Los datos de ${me.company.name} (usuarios, perfiles, equipos, tokens y apps) vuelven al momento de este respaldo. Lo que se cambió después se pierde. Las demás empresas y la facturación no se tocan. Después vas a tener que volver a entrar.`;
    const d = dialog('Restaurar respaldo', h('div', {}, h('p', {}, h('strong', {}, source.label)), h('div', { class: 'note bad' }, text),
      h('label', { for: 'r-p' }, 'Contraseña de cifrado del respaldo'), pass), [
      h('button', { onclick: () => d.close() }, 'Cancelar'),
      h('button', { class: 'danger', onclick: guard(async () => {
        toast('Restaurando…');
        const r = await source.run(pass.value);
        d.close();
        if (r.kind === 'general') {
          fill(header('Respaldos'), h('div', { class: 'sheet' }, h('h2', {}, 'Restaurando el sistema'), h('p', {}, 'El servidor se está reiniciando con el respaldo. En unos segundos vas a tener que volver a entrar.')));
          setTimeout(() => location.reload(), 8000);
          return;
        }
        toast(`Empresa restaurada${r.skipped.length ? `. Se omitió: ${r.skipped.join(', ')}` : ''}`, r.skipped.length > 0);
        setTimeout(() => location.reload(), 2500);
      }) }, 'Restaurar'),
    ]);
    pass.focus();
  }

  const remoteBox = h('div');
  async function loadRemote() {
    remoteBox.replaceChildren(h('p', { class: 'hint' }, 'Consultando los destinos…'));
    const list = await api('GET', `/api/backups/${scope}/remote`);
    const itemRow = (d, it) => h('tr', {},
      h('td', {}, it.name),
      h('td', {}, it.size ? sizeOf(it.size) : ''),
      h('td', {}, h('div', { class: 'row-actions' },
        h('a', { class: 'button', href: `/api/backups/${scope}/download/${d.destId}/${it.name}`, download: it.name }, 'Descargar'),
        h('button', {
          class: 'danger',
          onclick: () => restoreDialog({
            label: `${it.name}, desde ${d.name}`,
            run: (password) => api('POST', `/api/backups/${scope}/restore`, { destId: d.destId, name: it.name, password }),
          }),
        }, 'Restaurar'))));
    const destBlock = (d) => {
      let body;
      if (d.error) body = h('div', { class: 'note bad' }, d.error);
      else if (!d.items.length) body = h('p', { class: 'hint' }, 'No hay respaldos.');
      else body = h('div', { class: 'table-wrap' }, h('table', {}, h('tbody', {}, d.items.map((it) => itemRow(d, it)))));
      return h('div', {}, h('h3', {}, d.name), body);
    };
    remoteBox.replaceChildren(...list.map(destBlock));
    if (!list.length) remoteBox.replaceChildren(h('p', { class: 'hint' }, 'No hay destinos configurados.'));
  }

  function restoreSheet() {
    const file = h('input', { type: 'file', accept: '.wfbk', 'aria-label': 'Archivo de respaldo' });
    return h('div', { class: 'sheet' }, h('h2', {}, 'Restaurar'),
      h('p', {}, general ? 'Volvé todo el sistema a un respaldo anterior.' : `Volvé los datos de ${me.company.name} a un respaldo anterior, sin tocar a las demás empresas.`),
      h('div', { class: 'wrap-actions' }, h('button', { onclick: guard(loadRemote) }, 'Ver respaldos guardados')),
      remoteBox,
      h('h3', {}, 'Desde un archivo en tu PC'),
      h('div', { class: 'upload-row' }, file, h('button', { class: 'danger', onclick: () => {
        if (!file.files[0]) return toast('Elegí un archivo .wfbk', true);
        restoreDialog({ label: file.files[0].name, run: (password) => { const fd = new FormData(); fd.set('password', password); fd.set('file', file.files[0]); return api('POST', `/api/backups/${scope}/restore-file`, fd); } });
      } }, 'Restaurar este archivo')));
  }

  function paint() {
    const last = s.runs[0];
    fill(
      header(general ? 'Respaldo del sistema' : 'Respaldos', h('span', { class: 'spacer' }),
        h('button', { class: 'primary', disabled: s.running, onclick: guard(async () => { await api('POST', `/api/backups/${scope}/run`, {}); toast('Respaldo iniciado'); s = await api('GET', `/api/backups/${scope}`); paint(); poll(); }) }, s.running ? 'Respaldando…' : 'Respaldar ahora')),
      h('p', {}, general
        ? 'Copia todo el sistema: todas las empresas, usuarios, equipos, perfiles, archivos, facturación y configuración.'
        : `Copia los datos de ${me.company.name}: usuarios, perfiles, equipos, tokens de alta y apps de la biblioteca.`,
        ' ', s.enabled ? `Automático: ${s.frequency === 'weekly' ? `los ${WEEKDAYS[s.weekday].toLowerCase()}` : 'todos los días'} a las ${String(s.hour).padStart(2, '0')}:00.` : 'Sin respaldo automático.',
        last ? ` Último: ${dateTime(last.startedAt)}, ${(RUN_STATE[last.status] || [last.status])[0].toLowerCase()}.` : ''),
      scheduleSheet(), destSheet(), historySheet(), restoreSheet());
  }
  paint();
  if (s.running) poll();
}
