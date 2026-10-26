/**
 * Lógica de Turnos de Paseo
 * Vanilla JS. Los datos viven en Firestore (ver backend.js), un documento por perro,
 * persona, rutina, paseo, cambio de día y paseo hecho. Quién entra y quién edita
 * lo decide el documento access/members y las reglas de firestore.rules.
 */

// === CONFIGURACIÓN Y ESTADO ===
const COLORS = ['#E57373', '#F06292', '#BA68C8', '#64B5F6', '#4DD0E1', '#81C784', '#DCE775', '#FFB74D'];
const COLLECTIONS = ['dogs', 'people', 'routines', 'walks', 'overrides', 'checks'];
const DEFAULT_SHIFTS = { manana: '08:00', mediodia: '14:00', noche: '22:00' };

let isReadOnly = false;
let backend = null;
let unsubs = [];
let readyTimer = null;

function emptyData() {
  return {
    dogs: [], people: [], routines: [], walks: [], overrides: [], checks: [],
    settings: { shifts: { ...DEFAULT_SHIFTS } }
  };
}

let state = {
  data: emptyData(),
  ready: false,       // true cuando han llegado los datos del servidor (o de la caché sin conexión)
  currentDate: new Date(),
  selectedDate: new Date(),
  currentTab: 'view-calendar',
  filterPersonId: 'ALL',
  context: null // Para guardar IDs temporales de edición
};

// backend.js (módulo) llama a esto cuando Firebase está listo
window.resolveBackend = onBackend;

// === INICIALIZACIÓN ===
function init() {
  setupListeners();

  // Establecer fecha seleccionada a hoy (sin horas)
  state.selectedDate.setHours(0,0,0,0);
  state.currentDate.setHours(0,0,0,0);

  updateOnline();
  window.addEventListener('online', updateOnline);
  window.addEventListener('offline', updateOnline);

  renderAll();

  setTimeout(() => {
    if (!backend) showGate('No se pudo cargar la app. Comprueba tu conexión y vuelve a abrirla.');
  }, 15000);
}

function updateOnline() {
  document.getElementById('offline-banner').style.display = navigator.onLine ? 'none' : 'block';
}

// === ACCESO (pantalla de entrada) ===
function showGate(msg, { signIn = false, signOut = false } = {}) {
  document.getElementById('gate').hidden = false;
  document.getElementById('gate-msg').textContent = msg;
  document.getElementById('btn-signin').hidden = !signIn;
  document.getElementById('btn-signout-gate').hidden = !signOut;
}
function hideGate() {
  document.getElementById('gate').hidden = true;
}

function onBackend(api) {
  backend = api;
  if (!api.configured) {
    showGate('Falta conectar la base de datos. Sigue los pasos del README para configurar Firebase.');
    return;
  }
  api.onAuth(async user => {
    stopSync();
    closeSheets();
    if (!user) {
      showGate('Entra con tu cuenta de Google para ver los turnos.', { signIn: true });
      return;
    }
    showGate('Comprobando acceso…');
    let members;
    try {
      members = await api.getMembers();
    } catch (e) {
      if (e && e.code === 'permission-denied') {
        showGate(`La cuenta ${user.email} no tiene acceso. Pide a quien gestiona la app que la añada.`, { signOut: true });
      } else {
        showGate('No se pudo conectar. La primera vez que entras necesitas internet.', { signOut: true });
      }
      return;
    }
    const email = user.email.toLowerCase();
    const editors = (members && Array.isArray(members.editors)) ? members.editors.map(x => String(x).toLowerCase()) : [];
    applyReadOnly(!editors.includes(email));
    document.getElementById('account-email').textContent = user.email;
    hideGate();
    startSync();
  });
}

function signIn() {
  backend.signIn().catch(e => {
    if (e && (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request')) return;
    toast('No se pudo entrar. Inténtalo de nuevo.');
  });
}
function signOutUser() {
  backend.signOut();
}

// === SINCRONIZACIÓN ===
function startSync() {
  state.ready = false;
  const pending = new Set([...COLLECTIONS, 'config']);
  const arrived = (key, fromCache) => {
    // Con conexión esperamos a la respuesta del servidor; sin ella, vale la caché
    if (!(fromCache && navigator.onLine)) {
      pending.delete(key);
      if (pending.size === 0) state.ready = true;
    }
    scheduleRender();
  };
  COLLECTIONS.forEach(c => {
    unsubs.push(backend.subscribe(c, (docs, fromCache) => {
      state.data[c] = docs.map(x => normalize(c, x));
      arrived(c, fromCache);
    }, onSyncError));
  });
  unsubs.push(backend.subscribeDoc('config', 'settings', (s, fromCache) => {
    state.data.settings = { shifts: { ...DEFAULT_SHIFTS, ...(s && s.shifts) } };
    arrived('config', fromCache);
  }, onSyncError));
  readyTimer = setTimeout(() => {
    if (!state.ready) { state.ready = true; scheduleRender(); }
  }, 4000);
}

function stopSync() {
  unsubs.forEach(u => u());
  unsubs = [];
  clearTimeout(readyTimer);
  state.data = emptyData();
  state.ready = false;
  state.filterPersonId = 'ALL';
  renderAll();
}

// Los datos compartidos los escribe cualquiera con permiso: no confiar en su forma
function normalize(coll, x) {
  if (coll === 'routines' || coll === 'walks') {
    x.dogs = Array.isArray(x.dogs) ? x.dogs : [];
    x.time = typeof x.time === 'string' ? x.time : '';
  }
  if (coll === 'routines') x.days = Array.isArray(x.days) ? x.days : [];
  return x;
}

function onSyncError(e) {
  if (e && e.code === 'permission-denied') {
    stopSync();
    showGate('Ya no tienes acceso a estos turnos. Pide a quien gestiona la app que te vuelva a añadir.', { signOut: true });
  } else {
    toast('Se perdió la conexión con la base de datos. Cierra y vuelve a abrir la app.');
  }
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderAll(); });
}

// Escribe en Firestore. El cambio se ve al instante (también sin conexión) y se
// confirma en segundo plano, así que no esperamos al servidor. Devuelve si se lanzó.
function write(op) {
  if (isReadOnly) { toast('Solo lectura'); return false; }
  if (!state.ready) { toast('Cargando datos…'); return false; }
  op().catch(handleWriteError);
  return true;
}

function handleWriteError(e) {
  const code = e && e.code;
  if (code === 'permission-denied') {
    applyReadOnly(true);
    toast('Tu cuenta no tiene permiso para editar. Se ha deshecho el cambio.');
  } else if (code === 'resource-exhausted') {
    toast('Se ha llegado al límite gratuito de Firebase por hoy. Prueba mañana.');
  } else {
    toast('No se pudo guardar. Inténtalo de nuevo.');
  }
}

function put(coll, item) {
  const { id, ...body } = item;
  return write(() => backend.set(coll, id, body));
}
function del(coll, id) {
  return write(() => backend.remove(coll, id));
}

function applyReadOnly(readOnly) {
  isReadOnly = readOnly;
  document.getElementById('readonly-banner').style.display = readOnly ? 'block' : 'none';
  document.querySelectorAll('.auth-required').forEach(el => {
    el.style.display = readOnly ? 'none' : '';
    if(el.tagName === 'INPUT' || el.tagName === 'SELECT') el.disabled = readOnly;
  });
  if (readOnly) closeSheets();
  scheduleRender();
}

// === UTILIDADES DE FECHA Y HORA ===
function formatDateStr(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function parseDateStr(str) {
  if(!str) return null;
  const [y,m,d] = str.split('-');
  return new Date(y, m-1, d);
}
const formatterFull = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric' });
const formatterMonth = new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric' });

// Periodo derivado si no hay turno asignado
function getPeriod(timeStr) {
  if(!timeStr) return 'noche';
  const h = parseInt(timeStr.split(':')[0], 10);
  if (h < 12) return 'manana';
  if (h < 18) return 'mediodia';
  return 'noche';
}
function getShiftLabel(shift, time) {
  const s = shift || getPeriod(time);
  if(s === 'manana') return 'Mañana';
  if(s === 'mediodia') return 'Mediodía';
  return 'Noche';
}

// Ids ordenables por fecha de creación (Firestore entrega los documentos ordenados por id)
function generateId() { return Date.now().toString(36) + Math.random().toString(36).substring(2, 6); }
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toast(msg) {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

// === LÓGICA DE NEGOCIO (GENERAR PASEOS) ===
function getOccurrencesForDate(dateStr) {
  const targetDate = parseDateStr(dateStr);
  const dayOfWeek = targetDate.getDay() || 7; // 1=L, 7=D
  let occurrences = [];

  // 1. Rutinas
  state.data.routines.forEach(r => {
    if (!r.active) return;
    if (r.dogs.length === 0) return;
    if (!r.days.includes(dayOfWeek)) return;
    if (r.from && r.from > dateStr) return;

    const idKey = `r_${r.id}_${dateStr}`;
    const override = state.data.overrides.find(o => o.routineId === r.id && o.date === dateStr);

    if (override && override.action === 'skip') {
      occurrences.push({ id: idKey, ref: r, isRoutine: true, skipped: true, time: r.time, shift: r.shift, dur: r.dur });
      return;
    }

    let occ = {
      id: idKey, ref: r, isRoutine: true, skipped: false, changed: false,
      personId: r.personId, time: r.time, shift: r.shift, dur: r.dur
    };

    if (override && override.action === 'change') {
      occ.changed = true;
      occ.personId = override.personId !== undefined ? override.personId : r.personId;
      occ.time = String(override.time || r.time);
      occ.shift = override.shift !== undefined ? override.shift : r.shift;
    }
    occurrences.push(occ);
  });

  // 2. Puntuales (Walks)
  state.data.walks.forEach(w => {
    if (w.date === dateStr && w.dogs.length > 0) {
      occurrences.push({
        id: `w_${w.id}`, ref: w, isRoutine: false, skipped: false, changed: false,
        personId: w.personId, time: w.time, shift: w.shift, dur: w.dur
      });
    }
  });

  // Filtrar por persona si corresponde ("" = sin asignar)
  if (state.filterPersonId !== 'ALL') {
    occurrences = occurrences.filter(o => (o.personId || '') === state.filterPersonId);
  }

  // Agrupar y ordenar
  occurrences.forEach(o => { o.period = o.shift || getPeriod(o.time); });
  occurrences.sort((a,b) => {
    const periodOrder = { manana: 1, mediodia: 2, noche: 3 };
    if (periodOrder[a.period] !== periodOrder[b.period]) return periodOrder[a.period] - periodOrder[b.period];
    if (a.time !== b.time) return a.time.localeCompare(b.time);
    return 0; // Se podría ordenar por perro secundariamente
  });

  return occurrences;
}

// === RENDERIZADO UI ===

function renderAll() {
  updateFilterOptions();
  if (state.currentTab === 'view-calendar') renderCalendar();
  if (state.currentTab === 'view-routines') renderRoutines();
  if (state.currentTab === 'view-settings') renderSettings();

  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.target === state.currentTab));

  const fab = document.getElementById('main-fab');
  if(isReadOnly || state.currentTab === 'view-settings') {
    fab.style.display = 'none';
  } else {
    fab.style.display = 'flex';
    document.getElementById('fab-text').innerText = state.currentTab === 'view-calendar' ? 'Paseo' : 'Rutina';
  }
}

function updateFilterOptions() {
  const sel = document.getElementById('filter-person');
  const val = state.filterPersonId;
  sel.innerHTML = '<option value="ALL">Todos</option>' +
    state.data.people.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('') +
    '<option value="">Sin asignar</option>';
  sel.value = val;
  if (sel.value !== val) { state.filterPersonId = 'ALL'; sel.value = 'ALL'; }
}

function loadingState(what) {
  return `<div class="empty-state"><h3>Cargando ${what}…</h3></div>`;
}

function getDogDots(dogIds) {
  return dogIds.map(id => {
    const d = state.data.dogs.find(x => x.id === id);
    return d ? `<div class="dot" style="background:${esc(d.color)}"></div>` : '';
  }).join('');
}
function getDogNames(dogIds) {
  return dogIds.map(id => {
    const d = state.data.dogs.find(x => x.id === id);
    return d ? esc(d.name) : 'Desconocido';
  }).join(', ');
}
function getPersonName(id) {
  if(!id) return '';
  const p = state.data.people.find(x => x.id === id);
  return p ? esc(p.name) : '';
}

// -- Calendario --
function renderCalendar() {
  const selDateStr = formatDateStr(state.selectedDate);
  document.getElementById('calendar-month').innerText = formatterMonth.format(state.selectedDate);

  // Título del día
  const titleStr = formatterFull.format(state.selectedDate);
  document.getElementById('day-title').innerHTML = titleStr.charAt(0).toUpperCase() + titleStr.slice(1) + ` <span class="section-subtitle" id="day-subtitle"></span>`;

  // Días de la semana (Lunes a Domingo que contenga la fecha seleccionada)
  const dayOfWeek = state.selectedDate.getDay() || 7;
  const monday = new Date(state.selectedDate);
  monday.setDate(monday.getDate() - dayOfWeek + 1);

  let daysHtml = '';
  const todayStr = formatDateStr(state.currentDate);

  for(let i=0; i<7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const dStr = formatDateStr(d);

    // Obtener puntos
    const occ = getOccurrencesForDate(dStr).filter(o => !o.skipped);
    let dots = occ.slice(0, 4).map(o => {
      if(!o.personId) return `<div class="dot" style="background:var(--warn-text)"></div>`;
      const firstDogId = o.ref.dogs[0];
      const dog = state.data.dogs.find(x => x.id === firstDogId);
      return `<div class="dot" style="background:${dog ? esc(dog.color) : 'gray'}"></div>`;
    }).join('');

    const isSel = dStr === selDateStr ? 'selected' : '';
    const isToday = dStr === todayStr ? 'today' : '';
    const name = ['D','L','M','X','J','V','S'][d.getDay()];

    daysHtml += `
      <div class="day-btn ${isSel} ${isToday}" data-date="${dStr}">
        <span class="day-name">${name}</span>
        <span class="day-num mono">${d.getDate()}</span>
        <div class="day-dots">${dots}</div>
      </div>
    `;
  }
  document.getElementById('days-grid').innerHTML = daysHtml;

  // Lista de paseos
  const listEl = document.getElementById('calendar-list');
  if (!state.ready) { listEl.innerHTML = loadingState('paseos'); return; }
  const occ = getOccurrencesForDate(selDateStr);

  if (occ.length === 0) {
    listEl.innerHTML = state.data.dogs.length === 0 ? `
      <div class="empty-state">
        <h3>Empieza por tus perros</h3>
        <p>Añade perros y personas, o carga un ejemplo para ver cómo funciona.</p>
        <button class="btn btn-secondary auth-required" style="margin-top:16px" onclick="loadSampleData()">Cargar un ejemplo</button>
      </div>` : `
      <div class="empty-state">
        <h3>Sin paseos este día</h3>
        <p>Añade un paseo puntual o crea una rutina.</p>
        <button class="btn btn-secondary auth-required" style="margin-top:16px" onclick="openFormWalk()">Añadir paseo</button>
      </div>`;
    document.getElementById('day-subtitle').innerText = '0 paseos';
    if(isReadOnly) document.querySelectorAll('#calendar-list .btn').forEach(b => b.style.display = 'none');
    return;
  }

  let html = '';
  let currentPeriod = '';
  let doneCount = 0;
  let unassignedCount = 0;
  let totalActives = 0;

  occ.forEach(o => {
    if (!o.skipped) {
      totalActives++;
      if (!o.personId) unassignedCount++;
      const isDone = state.data.checks.some(c => c.id === o.id && c.done);
      if (isDone) doneCount++;
    }

    if (o.period !== currentPeriod) {
      const pLabel = o.period === 'manana' ? 'Mañana' : (o.period === 'mediodia' ? 'Mediodía' : 'Noche');
      html += `<div class="section-title" style="font-size:16px; margin: 16px 0 8px;">${pLabel}</div>`;
      currentPeriod = o.period;
    }

    const isDone = state.data.checks.some(c => c.id === o.id && c.done);
    const dogNames = getDogNames(o.ref.dogs);
    const personName = getPersonName(o.personId);

    let tags = [];
    if (!o.personId && !o.skipped) tags.push(`<span class="tag tag-unassigned">Sin asignar</span>`);
    if (!o.isRoutine) tags.push(`<span class="tag tag-routine">Puntual</span>`);
    if (o.changed) tags.push(`<span class="tag tag-changed">Cambiado hoy</span>`);
    if (o.skipped) tags.push(`<span class="tag tag-routine">Cancelado</span>`);

    html += `
      <div class="card ${o.skipped ? 'skipped' : ''}" onclick="openWalkMenu('${esc(o.id)}', ${o.isRoutine}, '${esc(o.ref.id)}', '${selDateStr}')">
        <div class="card-header">
          <div style="display:flex; align-items:center; gap:8px;">
            <span class="time-badge mono">${esc(o.time)}</span>
            <span class="dur-badge">${esc(o.dur)} min</span>
          </div>
          <div style="display:flex; gap:4px;">${getDogDots(o.ref.dogs)}</div>
        </div>
        <div class="card-title">${dogNames}</div>
        <div class="card-person">${personName ? '🚶 ' + personName : '⚠️ Nadie asignado'}</div>
        ${tags.length ? `<div class="tags">${tags.join('')}</div>` : ''}
        ${o.ref.note ? `<div class="card-note">${esc(o.ref.note)}</div>` : ''}
        ${!o.skipped ? `
          <div class="card-actions">
            <button class="btn-check ${isDone ? 'done' : ''} ${isReadOnly?'auth-required':''}"
              onclick="event.stopPropagation(); toggleCheck('${esc(o.id)}')">
              ${isDone ? '✓ Hecho' : 'Marcar hecho'}
            </button>
          </div>
        ` : ''}
      </div>
    `;
  });
  listEl.innerHTML = html;
  if(isReadOnly) {
    document.querySelectorAll('.btn-check').forEach(b => b.disabled = true);
  }

  let sub = `${totalActives} paseos`;
  if(doneCount > 0) sub += ` · ${doneCount} hechos`;
  if(unassignedCount > 0) sub += ` · ${unassignedCount} sin asignar`;
  document.getElementById('day-subtitle').innerText = sub;
}

// -- Rutinas --
function renderRoutines() {
  const listEl = document.getElementById('routines-list');
  if (!state.ready) { listEl.innerHTML = loadingState('rutinas'); return; }
  if (state.data.routines.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><h3>Aún no hay rutinas</h3><p>Establece horarios fijos semanales para los paseos.</p></div>`;
    return;
  }

  const dayNames = ['L','M','X','J','V','S','D'];
  let html = '';
  state.data.routines.forEach(r => {
    const dogs = getDogNames(r.dogs);
    const person = getPersonName(r.personId);
    const shiftLbl = getShiftLabel(r.shift, r.time);
    const daysChips = dayNames.map((d, i) =>
      `<span style="opacity: ${r.days.includes(i+1)?'1':'0.3'}; font-weight: ${r.days.includes(i+1)?'bold':'normal'}">${d}</span>`
    ).join(' ');

    html += `
      <div class="card" onclick="openFormRoutine('${esc(r.id)}')" style="opacity: ${r.active?1:0.6}">
        <div class="card-header">
          <div class="time-badge mono">${esc(r.time)} (${esc(r.dur)}m)</div>
          <div style="display:flex; gap:4px;">${getDogDots(r.dogs)}</div>
        </div>
        <div class="card-title">${dogs}</div>
        <div class="card-person">${person ? '🚶 ' + person : '⚠️ Sin asignar'}</div>
        <div class="mono" style="margin-top:12px; font-size:14px; color:var(--text-sec)">${daysChips}</div>
        <div class="tags" style="margin-top:8px;">
          <span class="tag tag-routine">${shiftLbl}</span>
          ${!r.active ? '<span class="tag tag-unassigned">En pausa</span>' : ''}
          ${r.from ? `<span class="tag tag-routine">Desde ${esc(r.from)}</span>` : ''}
        </div>
      </div>
    `;
  });
  listEl.innerHTML = html;
}

// -- Settings --
function renderSettings() {
  const dList = document.getElementById('dogs-list');
  const pList = document.getElementById('people-list');

  if (!state.ready) {
    dList.innerHTML = loadingState('perros');
    pList.innerHTML = '';
    return;
  }

  if (state.data.dogs.length === 0) {
    dList.innerHTML = `<div class="empty-state">
      <h3>Empieza por tus perros</h3>
      <button class="btn btn-secondary auth-required" onclick="loadSampleData()" style="margin-top:16px">Cargar un ejemplo</button>
    </div>`;
    if (isReadOnly) dList.querySelector('.btn').style.display = 'none';
  } else {
    dList.innerHTML = state.data.dogs.map(d => `
      <div class="list-item" onclick="openFormEntity('dog', '${esc(d.id)}')">
        <div class="list-item-content">
          <div class="dot" style="background:${esc(d.color)}; width:16px; height:16px; flex-shrink:0;"></div>
          <div><div style="font-weight:600">${esc(d.name)}</div>${d.note ? `<div style="font-size:12px; color:var(--text-sec)">${esc(d.note)}</div>`:''}</div>
        </div>
        <div style="color:var(--text-sec)">›</div>
      </div>
    `).join('');
  }

  pList.innerHTML = state.data.people.map(p => `
    <div class="list-item" onclick="openFormEntity('person', '${esc(p.id)}')">
      <div style="font-weight:600">${esc(p.name)}</div>
      <div style="color:var(--text-sec)">›</div>
    </div>
  `).join('');

  document.getElementById('set-shift-manana').value = state.data.settings.shifts.manana;
  document.getElementById('set-shift-mediodia').value = state.data.settings.shifts.mediodia;
  document.getElementById('set-shift-noche').value = state.data.settings.shifts.noche;
}

// === INTERACCIONES Y EVENTOS ===
function setupListeners() {
  // Entrada y cuenta
  document.getElementById('btn-signin').addEventListener('click', signIn);
  document.getElementById('btn-signout-gate').addEventListener('click', signOutUser);
  document.getElementById('btn-signout').addEventListener('click', signOutUser);

  // Tabs
  document.querySelectorAll('nav .tab').forEach(t => {
    t.addEventListener('click', () => switchTab(t.dataset.target));
    t.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchTab(t.dataset.target); }
    });
  });

  // Filtro por persona
  document.getElementById('filter-person').addEventListener('change', e => {
    state.filterPersonId = e.target.value;
    renderAll();
  });

  // Navegación de semanas
  document.getElementById('btn-prev-week').addEventListener('click', () => moveSelectedDate(-7));
  document.getElementById('btn-next-week').addEventListener('click', () => moveSelectedDate(7));
  document.getElementById('btn-today').addEventListener('click', () => {
    state.selectedDate = new Date(state.currentDate);
    renderAll();
  });
  document.getElementById('days-grid').addEventListener('click', e => {
    const btn = e.target.closest('.day-btn');
    if (!btn) return;
    state.selectedDate = parseDateStr(btn.dataset.date);
    renderAll();
  });

  // FAB
  document.getElementById('main-fab').addEventListener('click', () => {
    if (state.currentTab === 'view-calendar') openFormWalk();
    else if (state.currentTab === 'view-routines') openFormRoutine();
  });

  // Cerrar sheets (botón, clic fuera, Escape)
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeSheets));
  document.querySelectorAll('.sheet-overlay').forEach(o => o.addEventListener('click', e => {
    if (e.target === o) closeSheets();
  }));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheets(); });

  // Horarios de turnos
  ['manana', 'mediodia', 'noche'].forEach(s => {
    document.getElementById(`set-shift-${s}`).addEventListener('change', e => {
      if (e.target.value) updateShiftTime(s, e.target.value);
    });
  });

  // Turno <-> hora en los formularios
  bindShiftTime('fw-shift', 'fw-time');
  bindShiftTime('fr-shift', 'fr-time');

  // Chips (perros y días)
  ['fw-dogs', 'fr-dogs', 'fr-days'].forEach(id => {
    document.getElementById(id).addEventListener('click', e => {
      const c = e.target.closest('.chip');
      if (c) c.classList.toggle('active');
    });
  });

  // Selector de color
  document.getElementById('fe-color').addEventListener('click', e => {
    const c = e.target.closest('.color-circle');
    if (!c) return;
    state.context.color = c.dataset.color;
    renderColorPicker();
  });

  // Formularios
  document.getElementById('fw-save').addEventListener('click', saveWalkForm);
  document.getElementById('fw-delete').addEventListener('click', deleteWalk);
  document.getElementById('fr-save').addEventListener('click', saveRoutine);
  document.getElementById('fr-delete').addEventListener('click', deleteRoutine);
  document.getElementById('btn-add-dog').addEventListener('click', () => openFormEntity('dog'));
  document.getElementById('btn-add-person').addEventListener('click', () => openFormEntity('person'));
  document.getElementById('fe-save').addEventListener('click', saveEntity);
  document.getElementById('fe-delete').addEventListener('click', deleteEntity);

  // Confirmación
  document.getElementById('btn-confirm-yes').addEventListener('click', () => {
    const fn = state.confirmAction;
    state.confirmAction = null;
    closeSheets();
    if (fn) fn();
  });
}

function switchTab(target) {
  state.currentTab = target;
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === target));
  renderAll();
}

function moveSelectedDate(days) {
  const d = new Date(state.selectedDate);
  d.setDate(d.getDate() + days);
  state.selectedDate = d;
  renderAll();
}

// Elegir turno rellena la hora; cambiar la hora a mano lo pasa a "Personalizado"
function bindShiftTime(shiftId, timeId) {
  const shiftEl = document.getElementById(shiftId);
  const timeEl = document.getElementById(timeId);
  shiftEl.addEventListener('change', () => {
    if (shiftEl.value) timeEl.value = state.data.settings.shifts[shiftEl.value];
  });
  timeEl.addEventListener('change', () => {
    if (shiftEl.value && timeEl.value !== state.data.settings.shifts[shiftEl.value]) shiftEl.value = '';
  });
}

function updateShiftTime(shift, time) {
  const shifts = { ...state.data.settings.shifts, [shift]: time };
  if (!put('config', { id: 'settings', shifts })) return;
  // Las rutinas, paseos y cambios ligados a ese turno siguen su nueva hora
  ['routines', 'walks', 'overrides'].forEach(coll => {
    state.data[coll].forEach(x => {
      if (x.shift === shift && x.time !== time) put(coll, { ...x, time });
    });
  });
  toast(`Turno de ${getShiftLabel(shift).toLowerCase()} a las ${time}`);
}

// === SHEETS ===
function openSheet(id) {
  closeSheets();
  document.getElementById(id).classList.add('open');
}
function closeSheets() {
  document.querySelectorAll('.sheet-overlay.open').forEach(o => o.classList.remove('open'));
}
function askConfirm(msg, fn) {
  state.confirmAction = fn;
  document.getElementById('confirm-msg').textContent = msg;
  openSheet('sheet-confirm');
}
function guardWrite() {
  if (isReadOnly) { toast('Solo lectura'); return false; }
  return true;
}

function renderDogChips(containerId, selected) {
  const el = document.getElementById(containerId);
  if (state.data.dogs.length === 0) {
    el.innerHTML = `<p style="font-size:14px; color:var(--text-sec)">Añade primero un perro en «Perros y personas».</p>`;
    return;
  }
  el.innerHTML = state.data.dogs.map(d => `
    <div class="chip ${selected.includes(d.id) ? 'active' : ''}" data-id="${esc(d.id)}">
      <span class="dot" style="display:inline-block; background:${esc(d.color)}; margin-right:6px;"></span>${esc(d.name)}
    </div>
  `).join('');
}
function getSelectedDogs(containerId) {
  return [...document.querySelectorAll(`#${containerId} .chip.active`)].map(c => c.dataset.id);
}
function fillPersonSelect(id, value) {
  const sel = document.getElementById(id);
  sel.innerHTML = '<option value="">Sin asignar</option>' +
    state.data.people.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  sel.value = value || '';
}
function clampDur(val) {
  const n = parseInt(val, 10);
  if (!n) return 30;
  return Math.min(240, Math.max(5, n));
}

// -- Menú de un paseo --
function openWalkMenu(occId, isRoutine, refId, dateStr) {
  if (isReadOnly) return;
  const occ = getOccurrencesForDate(dateStr).find(o => o.id === occId);
  if (!occ) return;

  const isDone = state.data.checks.some(c => c.id === occId && c.done);
  const actions = [];
  if (!occ.skipped) {
    actions.push(['btn-primary', isDone ? 'Desmarcar como hecho' : 'Marcar como hecho', () => { closeSheets(); toggleCheck(occId); }]);
  }
  if (isRoutine) {
    if (occ.skipped) {
      actions.push(['btn-secondary', 'Recuperar este día', () => removeOverride(refId, dateStr)]);
    } else {
      actions.push(['btn-secondary', 'Cambiar solo este día', () => openFormOverride(refId, dateStr)]);
      if (occ.changed) actions.push(['btn-secondary', 'Deshacer el cambio de este día', () => removeOverride(refId, dateStr)]);
      actions.push(['btn-secondary', 'Saltar este día', () => skipDay(refId, dateStr)]);
    }
    actions.push(['btn-secondary', 'Editar rutina', () => openFormRoutine(refId)]);
  } else {
    actions.push(['btn-secondary', 'Editar paseo', () => openFormWalk(refId)]);
  }

  const el = document.getElementById('walk-menu-actions');
  el.innerHTML = '';
  actions.forEach(([cls, label, fn]) => {
    const b = document.createElement('button');
    b.className = `btn ${cls}`;
    b.textContent = label;
    b.addEventListener('click', fn);
    el.appendChild(b);
  });
  openSheet('sheet-walk-menu');
}

function toggleCheck(id) {
  const exists = state.data.checks.some(c => c.id === id);
  return exists ? del('checks', id) : put('checks', { id, done: true });
}

// -- Excepciones de rutina (override): un documento por rutina y día --
function setOverride(routineId, date, data) {
  const id = `${routineId}_${date}`;
  return data ? put('overrides', { id, routineId, date, ...data }) : del('overrides', id);
}
function skipDay(routineId, date) {
  closeSheets();
  if (setOverride(routineId, date, { action: 'skip' })) toast('Paseo saltado este día');
}
function removeOverride(routineId, date) {
  closeSheets();
  if (setOverride(routineId, date, null)) toast('Rutina restaurada para este día');
}

// -- Formulario de paseo --
function setWalkFormMode(isOverride) {
  ['fw-dogs-group', 'fw-date-group', 'fw-dur-group', 'fw-note-group'].forEach(id => {
    document.getElementById(id).style.display = isOverride ? 'none' : '';
  });
}

function openFormWalk(walkId) {
  if (!guardWrite()) return;
  const w = walkId ? state.data.walks.find(x => x.id === walkId) : null;
  state.context = { mode: w ? 'edit' : 'new', walkId: w ? w.id : null };
  setWalkFormMode(false);

  document.getElementById('fw-title').textContent = w ? 'Editar paseo' : 'Nuevo paseo';
  renderDogChips('fw-dogs', w ? w.dogs : []);
  fillPersonSelect('fw-person', w ? w.personId : '');
  document.getElementById('fw-date').value = w ? w.date : formatDateStr(state.selectedDate);
  document.getElementById('fw-shift').value = w ? (w.shift || '') : 'manana';
  document.getElementById('fw-time').value = w ? w.time : state.data.settings.shifts.manana;
  document.getElementById('fw-dur').value = w ? w.dur : 30;
  document.getElementById('fw-note').value = w ? (w.note || '') : '';
  document.getElementById('fw-delete').style.display = w ? 'flex' : 'none';
  openSheet('sheet-form-walk');
}

function openFormOverride(routineId, date) {
  const r = state.data.routines.find(x => x.id === routineId);
  if (!r) return;
  const ov = state.data.overrides.find(o => o.routineId === routineId && o.date === date && o.action === 'change');
  state.context = { mode: 'override', routineId, date };
  setWalkFormMode(true);

  const dayLabel = formatterFull.format(parseDateStr(date));
  document.getElementById('fw-title').textContent = `Cambiar el ${dayLabel}`;
  fillPersonSelect('fw-person', ov && ov.personId !== undefined ? ov.personId : r.personId);
  document.getElementById('fw-shift').value = (ov && ov.shift !== undefined ? ov.shift : r.shift) || '';
  document.getElementById('fw-time').value = (ov && ov.time) || r.time;
  document.getElementById('fw-delete').style.display = 'none';
  openSheet('sheet-form-walk');
}

function saveWalkForm() {
  if (!guardWrite()) return;
  const ctx = state.context || {};
  const personId = document.getElementById('fw-person').value;
  const shift = document.getElementById('fw-shift').value;
  const time = document.getElementById('fw-time').value;
  if (!time) { toast('Indica una hora'); return; }

  if (ctx.mode === 'override') {
    closeSheets();
    if (setOverride(ctx.routineId, ctx.date, { action: 'change', personId, shift, time })) {
      toast('Cambio guardado solo para este día');
    }
    return;
  }

  const dogs = getSelectedDogs('fw-dogs');
  if (dogs.length === 0) { toast('Elige al menos un perro'); return; }
  const date = document.getElementById('fw-date').value;
  if (!date) { toast('Indica una fecha'); return; }

  const data = {
    dogs, personId, date, shift, time,
    dur: clampDur(document.getElementById('fw-dur').value),
    note: document.getElementById('fw-note').value.trim()
  };
  const existing = ctx.mode === 'edit' && state.data.walks.find(x => x.id === ctx.walkId);
  state.selectedDate = parseDateStr(date);
  closeSheets();
  if (put('walks', existing ? { ...existing, ...data } : { id: generateId(), ...data })) {
    toast(existing ? 'Paseo actualizado' : 'Paseo añadido');
  }
  renderAll();
}

function deleteWalk() {
  const id = state.context && state.context.walkId;
  if (!id) return;
  askConfirm('Se eliminará este paseo puntual.', () => {
    if (!del('walks', id)) return;
    if (state.data.checks.some(c => c.id === `w_${id}`)) del('checks', `w_${id}`);
    toast('Paseo eliminado');
  });
}

// -- Formulario de rutina --
function openFormRoutine(routineId) {
  if (!guardWrite()) return;
  const r = routineId ? state.data.routines.find(x => x.id === routineId) : null;
  state.context = { routineId: r ? r.id : null };

  document.getElementById('fr-title').textContent = r ? 'Editar rutina' : 'Nueva rutina';
  renderDogChips('fr-dogs', r ? r.dogs : []);
  fillPersonSelect('fr-person', r ? r.personId : '');
  document.querySelectorAll('#fr-days .chip').forEach(c => {
    c.classList.toggle('active', r ? r.days.includes(Number(c.dataset.val)) : false);
  });
  document.getElementById('fr-shift').value = r ? (r.shift || '') : 'manana';
  document.getElementById('fr-time').value = r ? r.time : state.data.settings.shifts.manana;
  document.getElementById('fr-dur').value = r ? r.dur : 30;
  document.getElementById('fr-from').value = r ? (r.from || '') : '';
  document.getElementById('fr-note').value = r ? (r.note || '') : '';
  document.getElementById('fr-active').checked = r ? !!r.active : true;
  document.getElementById('fr-delete').style.display = r ? 'flex' : 'none';
  openSheet('sheet-form-routine');
}

function saveRoutine() {
  if (!guardWrite()) return;
  const dogs = getSelectedDogs('fr-dogs');
  if (dogs.length === 0) { toast('Elige al menos un perro'); return; }
  const days = [...document.querySelectorAll('#fr-days .chip.active')].map(c => Number(c.dataset.val));
  if (days.length === 0) { toast('Elige al menos un día'); return; }
  const time = document.getElementById('fr-time').value;
  if (!time) { toast('Indica una hora'); return; }

  const data = {
    dogs, days, time,
    personId: document.getElementById('fr-person').value,
    shift: document.getElementById('fr-shift').value,
    dur: clampDur(document.getElementById('fr-dur').value),
    from: document.getElementById('fr-from').value,
    note: document.getElementById('fr-note').value.trim(),
    active: document.getElementById('fr-active').checked
  };
  const existing = state.context.routineId && state.data.routines.find(x => x.id === state.context.routineId);
  closeSheets();
  if (put('routines', existing ? { ...existing, ...data } : { id: generateId(), ...data })) {
    toast(existing ? 'Rutina actualizada' : 'Rutina creada');
  }
}

function deleteRoutine() {
  const id = state.context && state.context.routineId;
  if (!id) return;
  askConfirm('Se eliminará la rutina y todos sus cambios de días concretos.', () => {
    if (!del('routines', id)) return;
    state.data.overrides.filter(o => o.routineId === id).forEach(o => del('overrides', o.id));
    state.data.checks.filter(c => c.id.startsWith(`r_${id}_`)).forEach(c => del('checks', c.id));
    toast('Rutina eliminada');
  });
}

// -- Formulario de perro / persona --
function openFormEntity(type, id) {
  if (!guardWrite()) return;
  const isDog = type === 'dog';
  const list = isDog ? state.data.dogs : state.data.people;
  const e = id ? list.find(x => x.id === id) : null;
  state.context = {
    type, id: e ? e.id : null,
    color: e && e.color ? e.color : COLORS[state.data.dogs.length % COLORS.length]
  };

  const noun = isDog ? 'perro' : 'persona';
  document.getElementById('fe-title').textContent = e ? `Editar ${noun}` : `Añadir ${noun}`;
  document.getElementById('fe-name').value = e ? e.name : '';
  document.getElementById('fe-note').value = e && e.note ? e.note : '';
  document.getElementById('fe-color-group').style.display = isDog ? '' : 'none';
  document.getElementById('fe-note-group').style.display = isDog ? '' : 'none';
  document.getElementById('fe-delete').style.display = e ? 'flex' : 'none';
  renderColorPicker();
  openSheet('sheet-form-entity');
}

function renderColorPicker() {
  document.getElementById('fe-color').innerHTML = COLORS.map(c =>
    `<div class="color-circle ${c === state.context.color ? 'active' : ''}" style="background:${c}" data-color="${c}" role="button" aria-label="Color ${c}"></div>`
  ).join('');
}

function saveEntity() {
  if (!guardWrite()) return;
  const ctx = state.context;
  const name = document.getElementById('fe-name').value.trim();
  if (!name) { toast('Escribe un nombre'); return; }

  const isDog = ctx.type === 'dog';
  const coll = isDog ? 'dogs' : 'people';
  const data = isDog
    ? { name, color: ctx.color, note: document.getElementById('fe-note').value.trim() }
    : { name };
  const existing = ctx.id && state.data[coll].find(x => x.id === ctx.id);
  closeSheets();
  if (put(coll, existing ? { ...existing, ...data } : { id: generateId(), ...data })) {
    toast(existing ? 'Guardado' : `${name} añadido`);
  }
}

function deleteEntity() {
  const { type, id } = state.context || {};
  if (!id) return;
  if (type === 'dog') {
    const dog = state.data.dogs.find(d => d.id === id);
    askConfirm(`Se quitará a ${dog.name} de todas las rutinas y paseos.`, () => {
      if (!del('dogs', id)) return;
      ['routines', 'walks'].forEach(coll => state.data[coll].forEach(x => {
        if (x.dogs.includes(id)) put(coll, { ...x, dogs: x.dogs.filter(d => d !== id) });
      }));
      toast('Perro eliminado');
    });
  } else {
    const person = state.data.people.find(p => p.id === id);
    askConfirm(`Los paseos de ${person.name} quedarán sin asignar.`, () => {
      if (!del('people', id)) return;
      ['routines', 'walks', 'overrides'].forEach(coll => state.data[coll].forEach(x => {
        if (x.personId === id) put(coll, { ...x, personId: '' });
      }));
      if (state.filterPersonId === id) state.filterPersonId = 'ALL';
      toast('Persona eliminada');
    });
  }
}

// -- Datos de ejemplo (solo al pulsar el botón) --
function loadSampleData() {
  if (!guardWrite()) return;
  const sh = state.data.settings.shifts;
  const luna = { id: generateId() + 'a', name: 'Luna', color: COLORS[3], note: 'Tira de la correa si ve otros perros' };
  const toby = { id: generateId() + 'b', name: 'Toby', color: COLORS[7], note: '' };
  const ana = { id: generateId() + 'a', name: 'Ana' };
  const marcos = { id: generateId() + 'b', name: 'Marcos' };
  const lucia = { id: generateId() + 'c', name: 'Lucía' };
  const base = { from: '', note: '', active: true };
  const routines = [
    { ...base, id: generateId() + 'a', dogs: [luna.id, toby.id], personId: ana.id, days: [1,2,3,4,5], shift: 'manana', time: sh.manana, dur: 30 },
    { ...base, id: generateId() + 'b', dogs: [luna.id], personId: marcos.id, days: [1,2,3,4,5,6,7], shift: 'mediodia', time: sh.mediodia, dur: 20, note: 'Solo vuelta a la manzana' },
    { ...base, id: generateId() + 'c', dogs: [luna.id, toby.id], personId: '', days: [1,2,3,4,5], shift: 'noche', time: sh.noche, dur: 45 },
    { ...base, id: generateId() + 'd', dogs: [toby.id], personId: lucia.id, days: [6,7], shift: 'noche', time: sh.noche, dur: 45 }
  ];

  const ok = [
    put('dogs', luna), put('dogs', toby),
    put('people', ana), put('people', marcos), put('people', lucia),
    ...routines.map(r => put('routines', r))
  ].every(Boolean);
  if (ok) toast('Ejemplo cargado');
}

init();
