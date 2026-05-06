'use strict';

const SCRIPT_URL       = 'https://script.google.com/macros/s/AKfycbwsXqoLZW8RlIAwvGN1yQXgpLnB3aCbVtjrmt4X5v302Fpbd9XFsSiobBOOTC4z1q5n/exec';
const CACHE_KEY        = 'vk_teacher_data';
const CACHE_TS_KEY     = 'vk_teacher_data_ts';
const CACHE_TTL        = 60 * 60 * 1000;
const TEACHER_NAME_KEY = 'vk_teacher_name';
const CONFLICT_RANGE_KEY = 'vk_conflict_range';
const STALE_DELAY      = 10 * 60 * 1000;
const UNDO_DELAY       = 6000;

const SCHOOL_CAL_URL    = 'https://sspkalender.prokom.no/api/iCalTidspunkt/?Kunde=nesakskoleruta&Id=0&Categories=438,439';
const SCHOOL_CAL_KEY    = 'vk_school_cal';
const SCHOOL_CAL_TS_KEY = 'vk_school_cal_ts';
const SCHOOL_CAL_TTL    = 24 * 60 * 60 * 1000;

const CLASS_GRADES = [
  { label: '8.',  classes: ['8A','8B','8C','8D','8E','8F'] },
  { label: '9.',  classes: ['9A','9B','9C','9D','9E','9F'] },
  { label: '10.', classes: ['10A','10B','10C','10D','10E','10F'] },
];
const CLASSES = CLASS_GRADES.flatMap(g => g.classes);

const SCHOOL_YEAR = getSchoolYearBounds(new Date());

let teacherData    = [];
let editingId      = null;
let cloneTemplate  = null; // populated when opening modal in "clone" mode
let showPast       = false;
let onlyMine       = false;
let conflictTimer  = null;
let currentView    = 'calendar';
let filterClasses  = [];
let filterStart    = '';
let filterEnd      = '';
let panelOpenDate  = null;
let modalBaseline  = null;
let lastFocusedEl  = null;
let staleTimer     = null;
let schoolDays     = loadCachedSchoolDays() || {}; // ISO date -> { type, summaries }

// id -> { entry, timer } for soft-deleted entries awaiting commit
const pendingDeletes = new Map();

let colFilterDate    = '';
let colFilterClass   = '';
let colFilterSubject = '';
let colFilterDesc    = '';
let colFilterTeacher = '';
let colFilterLegacy  = 'all';

// ─── Init ─────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', init);

function init() {
  setupLoginListeners();
  setupModalListeners();
  setupConfirmListeners();
  setupGlobalShortcuts();
  loadSchoolCalendar();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  if (sessionStorage.getItem('vk_token')) {
    showDashboard();
    loadData();
  } else {
    showLogin();
  }

  // Commit any pending soft-deletes if the page is being unloaded.
  window.addEventListener('beforeunload', flushPendingDeletes);
}

function injectDashboard() {
  if (document.getElementById('dashboard')) return;
  const template = document.getElementById('dashboardTemplate');
  document.body.appendChild(template.content.cloneNode(true));
  setupDashboardListeners();
  setupFilterClassBtns();
  applyDateInputBounds();
}

function setupLoginListeners() {
  document.getElementById('loginForm').addEventListener('submit', handleLogin);
}

function setupDashboardListeners() {
  document.getElementById('addBtn').addEventListener('click', () => openModal());
  document.getElementById('refreshBtn').addEventListener('click', () => loadData({ skipCache: true, background: true }));
  document.getElementById('logoutBtn').addEventListener('click', handleLogout);
  document.getElementById('jumpTodayBtn').addEventListener('click', jumpToToday);
  document.getElementById('showPastToggle').addEventListener('change', e => {
    showPast = e.target.checked;
    renderCurrentView();
  });
  document.getElementById('onlyMineToggle').addEventListener('change', e => {
    onlyMine = e.target.checked;
    renderCurrentView();
  });
  document.getElementById('viewTable').addEventListener('click', () => setView('table'));
  document.getElementById('viewCalendar').addEventListener('click', () => setView('calendar'));
  document.getElementById('filterStart').addEventListener('change', onFilterChange);
  document.getElementById('filterEnd').addEventListener('change', onFilterChange);
  document.getElementById('clearFilterClassesBtn').addEventListener('click', clearFilterClasses);
  document.getElementById('teacherPanelClose').addEventListener('click', closeTeacherPanel);
  document.getElementById('teacherPanelOverlay').addEventListener('click', closeTeacherPanel);
  document.getElementById('teacherPanelAdd').addEventListener('click', () => {
    const date = panelOpenDate;
    closeTeacherPanel();
    openModal({ defaultDate: date });
  });

  document.querySelector('#dataTable tbody').addEventListener('click', handleTableClick);
  ['cfDate','cfClass','cfSubject','cfDesc','cfTeacher'].forEach(id =>
    document.getElementById(id).addEventListener('input', debounce(onColFilterChange, 300))
  );
  document.getElementById('cfLegacy').addEventListener('change', onColFilterChange);

  // Mobile collapse: filter-bar toggle + per-section toggles
  document.getElementById('filterToggle').addEventListener('click', () => {
    const bar = document.getElementById('filterBar');
    const open = bar.classList.toggle('filter-open');
    document.getElementById('filterToggle').setAttribute('aria-expanded', String(open));
  });
  document.querySelectorAll('#filterBar .section-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const section = btn.closest('.filter-section');
      const open = section.classList.toggle('section-open');
      btn.setAttribute('aria-expanded', String(open));
    });
  });

  // Reflect initial state
  setView(currentView);
  updateFilterSummary();
}

function updateFilterSummary() {
  const classText = filterClasses.length === 0 ? 'Alle klasser' : filterClasses.join(', ');
  const dateText = (filterStart || filterEnd)
    ? `${filterStart ? formatDisplayDate(filterStart) : '…'} – ${filterEnd ? formatDisplayDate(filterEnd) : '…'}`
    : 'Alle datoer';
  const cs = document.getElementById('filterClassSummary');
  const ds = document.getElementById('filterDateSummary');
  const ts = document.getElementById('filterSummary');
  if (cs) cs.textContent = classText;
  if (ds) ds.textContent = dateText;
  if (ts) ts.textContent = `${classText} · ${dateText}`;
}

function setupModalListeners() {
  document.getElementById('modalClose').addEventListener('click', attemptCloseModal);
  document.getElementById('modalCancel').addEventListener('click', attemptCloseModal);
  document.getElementById('modalOverlay').addEventListener('click', attemptCloseModal);
  document.getElementById('modalForm').addEventListener('submit', handleSave);
  document.getElementById('modalDate').addEventListener('change', scheduleConflictFetch);

  const rangeSel = document.getElementById('conflictRange');
  rangeSel.value = localStorage.getItem(CONFLICT_RANGE_KEY) || '1';
  rangeSel.addEventListener('change', () => {
    localStorage.setItem(CONFLICT_RANGE_KEY, rangeSel.value);
    scheduleConflictFetch();
  });
}

function setupConfirmListeners() {
  document.getElementById('confirmCancel').addEventListener('click', closeConfirm);
  document.getElementById('confirmOverlay').addEventListener('click', closeConfirm);
}

function applyDateInputBounds() {
  const modalDate = document.getElementById('modalDate');
  modalDate.min = SCHOOL_YEAR.start;
  modalDate.max = SCHOOL_YEAR.end;
  // Filter date inputs intentionally have no min/max so teachers can browse legacy data.
}

// ─── Auth ─────────────────────────────────────────────────────

async function handleLogin(e) {
  e.preventDefault();
  const password = document.getElementById('passwordInput').value;
  const name     = document.getElementById('loginNameInput').value.trim();
  const errEl    = document.getElementById('loginError');
  const btn      = document.getElementById('loginBtn');

  errEl.textContent = '';

  if (!name) { errEl.textContent = 'Skriv inn navnet ditt.'; return; }

  btn.disabled = true;
  btn.textContent = 'Logger inn…';

  try {
    const res  = await fetch(SCRIPT_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({ action: 'login', password })
    });
    const data = await res.json();

    if (data.error) {
      errEl.textContent = data.error;
      document.getElementById('wrongPasswordImg').hidden = data.error !== 'Feil passord';
    } else {
      document.getElementById('wrongPasswordImg').hidden = true;
      localStorage.setItem(TEACHER_NAME_KEY, name);
      sessionStorage.setItem('vk_token', data.token);
      showDashboard();
      loadData();
    }
  } catch {
    errEl.textContent = 'Nettverksfeil. Prøv igjen.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Logg inn';
  }
}

function handleLogout() {
  flushPendingDeletes(); // commit any deferred deletes synchronously
  sessionStorage.removeItem('vk_token');
  teacherData = [];
  showLogin();
}

// ─── Views ────────────────────────────────────────────────────

function showLogin() {
  ['dashboard', 'teacherPanel', 'teacherPanelOverlay'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.remove();
  });
  teacherData = [];
  document.getElementById('loginView').hidden = false;
  document.getElementById('passwordInput').value = '';
  document.getElementById('loginNameInput').value = localStorage.getItem(TEACHER_NAME_KEY) || '';
  document.getElementById('loginError').textContent = '';
  document.getElementById('wrongPasswordImg').hidden = true;
}

function showDashboard() {
  document.getElementById('loginView').hidden = true;
  injectDashboard();
}

// ─── Data loading ──────────────────────────────────────────────

async function loadData(opts = {}) {
  const cached = getCachedData();

  if (cached && !opts.skipCache) {
    teacherData = cached;
    renderCurrentView();
    updateStatus();
    hideOverlay();
    fetchTeacherData({ background: true });
    return;
  }

  const background = opts.background && teacherData.length > 0;
  await fetchTeacherData({ background });
}

async function fetchTeacherData({ background = false } = {}) {
  if (background) showBgLoading();
  else showOverlay();

  try {
    const token = sessionStorage.getItem('vk_token');
    const res   = await fetch(`${SCRIPT_URL}?action=all&token=${encodeURIComponent(token)}`);
    const data  = await res.json();

    if (data.error === 'Unauthorized') { handleLogout(); return; }
    if (!Array.isArray(data)) throw new Error('Ugyldig svar fra server');

    teacherData = data;
    setCachedData(teacherData);
    renderCurrentView();
    updateStatus();
    clearStale();

    if (background) hideBgLoading();
    else hideOverlay();
  } catch (err) {
    if (background) {
      hideBgLoading();
      scheduleStaleSignal();
    } else {
      showOverlayError('Kunne ikke laste data: ' + err.message);
    }
  }
}

// ─── Filtering ─────────────────────────────────────────────────

function onFilterChange() {
  const startEl = document.getElementById('filterStart');
  const endEl   = document.getElementById('filterEnd');
  let start = startEl.value, end = endEl.value;
  if (start && end && start > end) {
    [startEl.value, endEl.value] = [end, start];
    [start, end] = [end, start];
    showToast('Datointervallet ble byttet om');
  }
  filterStart = start;
  filterEnd   = end;
  updateFilterSummary();
  renderCurrentView();
}

function setupFilterClassBtns() {
  const container = document.getElementById('filterClassBtns');
  container.innerHTML = '';
  CLASS_GRADES.forEach(group => {
    const wrap = document.createElement('div');
    wrap.className = 'class-grade-group';
    const lbl = document.createElement('span');
    lbl.className = 'class-grade-label';
    lbl.textContent = group.label;
    wrap.appendChild(lbl);
    group.classes.forEach(cls => {
      const btn = document.createElement('button');
      btn.type        = 'button';
      btn.className   = 'filter-class-btn';
      btn.textContent = cls;
      btn.dataset.cls = cls;
      btn.addEventListener('click', () => {
        btn.classList.toggle('active');
        filterClasses = [...container.querySelectorAll('.filter-class-btn.active')].map(b => b.dataset.cls);
        updateClearFilterClassesBtn();
        updateFilterSummary();
        renderCurrentView();
      });
      wrap.appendChild(btn);
    });
    container.appendChild(wrap);
  });
  updateClearFilterClassesBtn();
}

function updateClearFilterClassesBtn() {
  const btn = document.getElementById('clearFilterClassesBtn');
  if (btn) btn.hidden = filterClasses.length === 0;
}

function clearFilterClasses() {
  filterClasses = [];
  document.querySelectorAll('#filterClassBtns .filter-class-btn').forEach(b => b.classList.remove('active'));
  updateClearFilterClassesBtn();
  updateFilterSummary();
  renderCurrentView();
}

function onColFilterChange() {
  colFilterDate    = document.getElementById('cfDate').value.trim();
  colFilterClass   = document.getElementById('cfClass').value.trim();
  colFilterSubject = document.getElementById('cfSubject').value.trim();
  colFilterDesc    = document.getElementById('cfDesc').value.trim();
  colFilterTeacher = document.getElementById('cfTeacher').value.trim();
  colFilterLegacy  = document.getElementById('cfLegacy').value;
  if (currentView === 'table') renderTable();
}

function getFilteredData() {
  const today = toISODate(new Date());
  const myName = (localStorage.getItem(TEACHER_NAME_KEY) || '').toLowerCase().trim();

  return teacherData.filter(e => {
    if (!showPast && e.date < today) return false;
    if (onlyMine && myName) {
      if (!(e.teacher || '').toLowerCase().includes(myName)) return false;
    }
    if (filterClasses.length > 0) {
      const entryClasses = e.classes.toUpperCase().replace(/,/g, ' ').split(/\s+/).filter(Boolean);
      if (!filterClasses.some(fc => entryClasses.includes(fc.toUpperCase()))) return false;
    }
    if (filterStart && e.date < filterStart) return false;
    if (filterEnd   && e.date > filterEnd)   return false;
    return true;
  });
}

function getTableFilteredData() {
  return getFilteredData().filter(e => {
    if (colFilterDate    && !formatDisplayDate(e.date).includes(colFilterDate))                               return false;
    if (colFilterClass   && !e.classes.toUpperCase().includes(colFilterClass.toUpperCase()))                  return false;
    if (colFilterSubject && !e.subject.toUpperCase().includes(colFilterSubject.toUpperCase()))                 return false;
    if (colFilterDesc    && !(e.description||e.notes||'').toUpperCase().includes(colFilterDesc.toUpperCase())) return false;
    if (colFilterTeacher && !(e.teacher||'').toUpperCase().includes(colFilterTeacher.toUpperCase()))           return false;
    if (colFilterLegacy === 'new'    &&  e.isLegacy) return false;
    if (colFilterLegacy === 'legacy' && !e.isLegacy) return false;
    return true;
  });
}

// ─── View management ───────────────────────────────────────────

function setView(view) {
  currentView = view;
  document.getElementById('tableView').hidden    = view !== 'table';
  document.getElementById('calendarView').hidden = view !== 'calendar';
  document.getElementById('viewTable').classList.toggle('active', view === 'table');
  document.getElementById('viewCalendar').classList.toggle('active', view === 'calendar');
  closeTeacherPanel();
  renderCurrentView();
}

function renderCurrentView() {
  if (currentView === 'table') renderTable();
  else renderTeacherCalendar();
}

// ─── Table rendering ───────────────────────────────────────────

const LEGACY_NOTE = 'Denne vurderingen er fra det gamle systemet, og kan ikke redigeres her. Ta kontakt med Benjamin for å endre denne vurderingen.';

function renderTable() {
  const tbody = document.querySelector('#dataTable tbody');
  tbody.innerHTML = '';

  const today = toISODate(new Date());
  const rows  = getTableFilteredData().sort((a, b) => a.date.localeCompare(b.date));

  if (rows.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="6" class="empty-cell">Ingen vurderinger å vise.</td>`;
    tbody.appendChild(tr);
    return;
  }

  rows.forEach(entry => {
    const tr = document.createElement('tr');
    tr.className = 'data-row';
    if (entry.date < today) tr.classList.add('past-row');
    if (entry.isLegacy)     tr.classList.add('legacy-row');

    const actionCell = entry.isLegacy
      ? `<button class="icon-btn" title="Kopier" data-id="${escapeHtml(entry.id)}" data-action="clone">&#x2398;</button>
         <span class="legacy-badge">Gammelt system</span>`
      : `<button class="icon-btn" title="Rediger" data-id="${escapeHtml(entry.id)}" data-action="edit">&#9998;</button>
         <button class="icon-btn" title="Kopier" data-id="${escapeHtml(entry.id)}" data-action="clone">&#x2398;</button>
         <button class="icon-btn icon-btn-danger" title="Slett" data-id="${escapeHtml(entry.id)}" data-action="delete">&#10005;</button>`;

    tr.innerHTML = `
      <td data-label="Dato">${formatDisplayDate(entry.date)}</td>
      <td data-label="Klasse(r)">${escapeHtml(entry.classes)}</td>
      <td data-label="Fag">${escapeHtml(entry.subject)}</td>
      <td data-label="Beskrivelse" class="desc-cell">${escapeHtml(entry.description || entry.notes || '')}</td>
      <td data-label="Lærer">${escapeHtml(entry.teacher || '')}</td>
      <td class="action-cell">${actionCell}</td>
    `;

    const expandTr = document.createElement('tr');
    expandTr.className = 'expand-row';
    expandTr.hidden    = true;

    const expandTd = document.createElement('td');
    expandTd.colSpan   = 6;
    expandTd.className = 'expand-cell';

    const desc = entry.description || entry.notes || '';
    if (desc) {
      const p = document.createElement('p');
      p.className   = 'expand-desc';
      p.textContent = desc;
      expandTd.appendChild(p);
    } else if (!entry.isLegacy) {
      const p = document.createElement('p');
      p.className   = 'expand-desc expand-empty';
      p.textContent = 'Ingen beskrivelse.';
      expandTd.appendChild(p);
    }

    if (entry.isLegacy) {
      const note = document.createElement('p');
      note.className   = 'expand-legacy-note';
      note.textContent = LEGACY_NOTE;
      expandTd.appendChild(note);
    }

    expandTr.appendChild(expandTd);

    tr.addEventListener('click', e => {
      if (e.target.closest('[data-action]') || e.target.closest('.legacy-badge')) return;
      const opening = expandTr.hidden;
      expandTr.hidden = !opening;
      tr.classList.toggle('row-expanded', opening);
    });

    tbody.appendChild(tr);
    tbody.appendChild(expandTr);
  });
}

function handleTableClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { id, action } = btn.dataset;
  if (action === 'edit')   openModal({ id });
  if (action === 'delete') handleDelete(id);
  if (action === 'clone') {
    const entry = teacherData.find(x => x.id === id);
    if (entry) openModal({ cloneFrom: entry });
  }
}

// ─── Teacher calendar ──────────────────────────────────────────

function renderTeacherCalendar() {
  const container = document.getElementById('teacherCalendar');
  container.innerHTML = '';

  const byDate = {};
  getFilteredData().forEach(e => {
    if (!byDate[e.date]) byDate[e.date] = [];
    byDate[e.date].push(e);
  });

  const today = new Date();
  const start = filterStart ? new Date(filterStart) : today;
  const end   = filterEnd   ? new Date(filterEnd)
                            : new Date(today.getFullYear(), today.getMonth() + 2, today.getDate());

  let cursor   = new Date(start.getFullYear(), start.getMonth(), 1);
  const endMonth = new Date(end.getFullYear(), end.getMonth(), 1);

  while (cursor <= endMonth) {
    container.appendChild(buildTeacherMonthCard(cursor, byDate));
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }
}

function buildTeacherMonthCard(monthDate, byDate) {
  const year  = monthDate.getFullYear();
  const month = monthDate.getMonth();

  const card = document.createElement('section');
  card.className = 'month-card';

  const title = document.createElement('h2');
  title.className = 'month-title';

  const name = document.createElement('span');
  name.className = 'month-name';
  name.textContent = capitalizeFirst(monthDate.toLocaleString('no', { month: 'long', year: 'numeric' }));
  title.appendChild(name);

  const navGroup = document.createElement('span');
  navGroup.className = 'month-nav-group';
  const prev = document.createElement('button');
  prev.type = 'button';
  prev.className = 'month-nav month-nav-prev';
  prev.setAttribute('aria-label', 'Forrige måned');
  prev.innerHTML = '&lsaquo;';
  prev.addEventListener('click', () => {
    card.previousElementSibling?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'month-nav month-nav-next';
  next.setAttribute('aria-label', 'Neste måned');
  next.innerHTML = '&rsaquo;';
  next.addEventListener('click', () => {
    card.nextElementSibling?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  navGroup.appendChild(prev);
  navGroup.appendChild(next);
  title.appendChild(navGroup);

  card.appendChild(title);

  const table = document.createElement('table');
  table.className = 'cal-table';

  const thead = table.createTHead();
  const hRow  = thead.insertRow();
  ['Uke','Man','Tir','Ons','Tor','Fre','Lør','Søn'].forEach(label => {
    const th = document.createElement('th');
    th.textContent = label;
    hRow.appendChild(th);
  });

  const tbody   = table.createTBody();
  const todayKey = toISODate(new Date());

  let cursor = new Date(year, month, 1);
  const startDow = cursor.getDay() || 7;
  cursor.setDate(cursor.getDate() - startDow + 1);

  const lastDay = new Date(year, month + 1, 0).getDate();
  const weeks   = Math.ceil((lastDay + startDow - 1) / 7);

  for (let w = 0; w < weeks; w++) {
    const tr = tbody.insertRow();
    const wk = document.createElement('td');
    wk.className   = 'week-num';
    wk.textContent = getWeekNumber(cursor);
    tr.appendChild(wk);

    for (let d = 0; d < 7; d++) {
      const td = document.createElement('td');

      if (cursor.getMonth() === month) {
        const dateKey = toISODate(cursor);
        const entries = byDate[dateKey] || [];

        td.className = 'day';
        if (d >= 5) td.classList.add('weekend');
        if (dateKey === todayKey) td.classList.add('today');
        applySchoolDay(td, dateKey);

        const num = document.createElement('span');
        num.className   = 'day-num';
        num.textContent = cursor.getDate();
        td.appendChild(num);

        if (entries.length > 0) {
          td.classList.add('has-assessments');
          const dotsWrap = document.createElement('span');
          dotsWrap.className = 'dots';
          for (let i = 0; i < Math.min(entries.length, 4); i++) {
            const dot = document.createElement('span');
            dot.className = 'dot';
            dotsWrap.appendChild(dot);
          }
          td.appendChild(dotsWrap);
        }

        const snapDate    = new Date(cursor);
        const snapEntries = entries.slice();
        td.tabIndex = 0;
        td.setAttribute('role', 'button');
        td.setAttribute('aria-label', `${cursor.getDate()}. ${monthDate.toLocaleString('no', { month: 'long' })}, ${entries.length} vurdering${entries.length !== 1 ? 'er' : ''}`);
        td.addEventListener('click', () => openTeacherPanel(snapDate, snapEntries));
        td.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTeacherPanel(snapDate, snapEntries); }
        });
      } else {
        td.className   = 'day other-month';
        if (d >= 5) td.classList.add('weekend');
        td.textContent = cursor.getDate();
      }

      tr.appendChild(td);
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  card.appendChild(table);
  return card;
}

function jumpToToday() {
  if (currentView === 'calendar') {
    let cell = document.querySelector('#teacherCalendar .day.today');
    if (!cell) {
      // Bring today into the visible range — clear filter dates and re-render.
      filterStart = ''; filterEnd = '';
      const fs = document.getElementById('filterStart');
      const fe = document.getElementById('filterEnd');
      if (fs) fs.value = ''; if (fe) fe.value = '';
      renderCurrentView();
      cell = document.querySelector('#teacherCalendar .day.today');
    }
    cell?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else {
    // Table view — scroll to first row dated today or after.
    const todayISO = toISODate(new Date());
    const rows = [...document.querySelectorAll('#dataTable tbody .data-row')];
    const target = rows.find(r => !r.classList.contains('past-row'));
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// ─── Teacher day panel ─────────────────────────────────────────

function openTeacherPanel(date, entries) {
  rememberFocus();
  panelOpenDate = toISODate(date);
  document.getElementById('teacherPanelTitle').textContent = formatDateLong(date);

  const body = document.getElementById('teacherPanelBody');
  body.innerHTML = '';

  const sch = schoolDays[toISODate(date)];
  if (sch) body.appendChild(buildSchoolDayCard(sch));

  if (entries.length === 0) {
    const p = document.createElement('p');
    p.className   = 'panel-empty';
    p.textContent = 'Ingen vurderinger denne dagen.';
    body.appendChild(p);
  } else {
    entries.forEach(e => {
      const card = document.createElement('div');
      card.className = 'assessment-card';

      const info = document.createElement('div');
      info.className = 'ac-info';

      const subject = document.createElement('div');
      subject.className   = 'ac-subject';
      subject.textContent = e.subject;
      info.appendChild(subject);

      const classes = document.createElement('div');
      classes.className   = 'ac-classes';
      classes.textContent = e.classes;
      info.appendChild(classes);

      if (e.description || e.notes) {
        const desc = document.createElement('div');
        desc.className   = 'ac-desc';
        desc.textContent = e.description || e.notes;
        info.appendChild(desc);
      }

      if (e.teacher) {
        const teacher = document.createElement('div');
        teacher.className   = 'ac-teacher';
        teacher.textContent = e.teacher;
        info.appendChild(teacher);
      }

      card.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'ac-panel-actions';

      if (!e.isLegacy) {
        const editBtn = document.createElement('button');
        editBtn.className   = 'btn btn-sm btn-ghost';
        editBtn.textContent = 'Rediger';
        editBtn.addEventListener('click', () => { closeTeacherPanel(); openModal({ id: e.id }); });
        actions.appendChild(editBtn);
      }

      const cloneBtn = document.createElement('button');
      cloneBtn.className   = 'btn btn-sm btn-ghost';
      cloneBtn.textContent = 'Kopier';
      cloneBtn.addEventListener('click', () => { closeTeacherPanel(); openModal({ cloneFrom: e }); });
      actions.appendChild(cloneBtn);

      if (!e.isLegacy) {
        const delBtn = document.createElement('button');
        delBtn.className   = 'btn btn-sm btn-ghost-danger';
        delBtn.textContent = 'Slett';
        delBtn.addEventListener('click', () => handleDelete(e.id));
        actions.appendChild(delBtn);
      } else {
        const badge = document.createElement('span');
        badge.className   = 'legacy-badge';
        badge.textContent = 'Gammelt system';
        actions.appendChild(badge);
      }

      card.appendChild(actions);
      body.appendChild(card);
    });
  }

  document.getElementById('teacherPanelOverlay').classList.add('open');
  document.getElementById('teacherPanel').classList.add('open');
  setTimeout(() => document.getElementById('teacherPanelClose')?.focus(), 60);
}

function closeTeacherPanel() {
  document.getElementById('teacherPanelOverlay')?.classList.remove('open');
  document.getElementById('teacherPanel')?.classList.remove('open');
  panelOpenDate = null;
  restoreFocus();
}

// ─── Modal ─────────────────────────────────────────────────────

function openModal(opts = {}) {
  editingId     = opts.id || null;
  cloneTemplate = (!editingId && opts.cloneFrom) ? opts.cloneFrom : null;

  const entry = editingId ? teacherData.find(e => e.id === editingId) : null;
  const source = entry || cloneTemplate;
  const isEdit  = !!entry;
  const isClone = !!cloneTemplate;

  document.getElementById('modalTitle').textContent =
    isEdit ? 'Rediger vurdering' : (isClone ? 'Kopier vurdering' : 'Legg til vurdering');

  document.getElementById('modalDate').value        = isEdit ? entry.date : (opts.defaultDate || '');
  document.getElementById('modalSubject').value     = source ? source.subject : '';
  document.getElementById('modalDescription').value = source ? (source.description || source.notes || '') : '';
  document.getElementById('modalTeacher').value     = isEdit
    ? (source.teacher || '')
    : (localStorage.getItem(TEACHER_NAME_KEY) || '');
  document.getElementById('modalError').textContent = '';

  let selected;
  if (source) selected = source.classes.split(' ').filter(Boolean);
  else        selected = filterClasses.length ? [...filterClasses] : [];
  renderClassToggles(selected);

  clearConflicts();
  if (isEdit || opts.defaultDate || isClone) scheduleConflictFetch();

  rememberFocus();
  document.getElementById('modalOverlay').classList.add('open');
  document.getElementById('modal').classList.add('open');
  document.getElementById('modalDate').focus();

  modalBaseline = serializeModalState();
}

function attemptCloseModal() {
  if (modalBaseline !== null && serializeModalState() !== modalBaseline) {
    showConfirm('Du har ulagrede endringer. Forkast?', () => doCloseModal());
    return;
  }
  doCloseModal();
}

function doCloseModal() {
  document.getElementById('modalOverlay').classList.remove('open');
  document.getElementById('modal').classList.remove('open');
  editingId     = null;
  cloneTemplate = null;
  modalBaseline = null;
  clearTimeout(conflictTimer);
  restoreFocus();
}

function serializeModalState() {
  return JSON.stringify({
    date:        document.getElementById('modalDate').value,
    subject:     document.getElementById('modalSubject').value,
    description: document.getElementById('modalDescription').value,
    teacher:     document.getElementById('modalTeacher').value,
    classes:     getSelectedClasses().slice().sort().join(',')
  });
}

async function handleSave(e) {
  e.preventDefault();
  const errEl   = document.getElementById('modalError');
  const classes = getSelectedClasses();

  if (classes.length === 0) { errEl.textContent = 'Velg minst én klasse.'; return; }

  const payload = {
    date:        document.getElementById('modalDate').value,
    subject:     document.getElementById('modalSubject').value.trim(),
    classes:     classes.join(' '),
    description: document.getElementById('modalDescription').value.trim(),
    teacher:     document.getElementById('modalTeacher').value.trim()
  };

  if (!payload.date)        { errEl.textContent = 'Dato er påkrevd.'; return; }
  if (!payload.subject)     { errEl.textContent = 'Fag er påkrevd.'; return; }
  if (!payload.description) { errEl.textContent = 'Beskrivelse er påkrevd.'; return; }
  if (!payload.teacher)     { errEl.textContent = 'Lærer er påkrevd.'; return; }
  if (payload.date < SCHOOL_YEAR.start || payload.date > SCHOOL_YEAR.end) {
    errEl.textContent = `Datoen må være innenfor inneværende skoleår (${formatDisplayDate(SCHOOL_YEAR.start)} - ${formatDisplayDate(SCHOOL_YEAR.end)}).`;
    return;
  }

  errEl.textContent = '';
  if (payload.teacher) localStorage.setItem(TEACHER_NAME_KEY, payload.teacher);

  const warning = getDateWarning(payload.date);
  if (warning) {
    showConfirm(warning, () => performSave(payload));
    return;
  }
  performSave(payload);
}

function getDateWarning(isoDate) {
  const sch = schoolDays[isoDate];
  if (sch && sch.type === 'off') {
    return `${formatDisplayDate(isoDate)} er markert som "${sch.summaries.join(', ')}" i Nes kommunes skolerute.\n\nVil du likevel legge til en vurdering på denne datoen?`;
  }
  // Date-only string → use UTC to avoid local-tz off-by-one
  const [y, m, d] = isoDate.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun, 6=Sat
  if (dow === 0 || dow === 6) {
    const name = dow === 0 ? 'søndag' : 'lørdag';
    return `${formatDisplayDate(isoDate)} er en ${name}.\n\nVil du likevel legge til en vurdering på denne datoen?`;
  }
  return null;
}

async function performSave(payload) {
  const errEl   = document.getElementById('modalError');
  const saveBtn = document.getElementById('saveBtn');

  const token  = sessionStorage.getItem('vk_token');
  const action = editingId ? 'update' : 'create';
  const body   = new URLSearchParams({ action, token, ...payload });
  if (editingId) body.set('id', editingId);

  saveBtn.disabled    = true;
  saveBtn.textContent = 'Lagrer…';
  errEl.textContent   = '';

  try {
    const res  = await fetch(SCRIPT_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const data = await res.json();

    if (data.error) { errEl.textContent = data.error; return; }

    if (editingId) {
      const idx = teacherData.findIndex(e => e.id === editingId);
      if (idx !== -1) teacherData[idx] = { ...teacherData[idx], ...payload, notes: payload.description };
      showToast('Vurdering oppdatert');
    } else {
      teacherData.push(data);
      showToast(cloneTemplate ? 'Kopi lagret' : 'Vurdering lagret');
    }

    setCachedData(teacherData);
    modalBaseline = null;
    doCloseModal();
    renderCurrentView();
  } catch {
    errEl.textContent = 'Nettverksfeil. Prøv igjen.';
  } finally {
    saveBtn.disabled    = false;
    saveBtn.textContent = 'Lagre';
  }
}

// ─── Soft delete with undo ─────────────────────────────────────

function handleDelete(id) {
  const entry = teacherData.find(e => e.id === id);
  if (!entry) return;
  const label = `${formatDisplayDate(entry.date)} - ${entry.subject} (${entry.classes})`;

  showConfirm(`Vil du slette denne vurderingen?\n\n${label}`, () => {
    const idx = teacherData.findIndex(e => e.id === id);
    if (idx === -1) return;
    const removed = teacherData.splice(idx, 1)[0];
    setCachedData(teacherData);
    closeTeacherPanel();
    renderCurrentView();

    const timer = setTimeout(() => commitDelete(id), UNDO_DELAY);
    pendingDeletes.set(id, { entry: removed, timer });

    showToast(`Slettet: ${entry.subject}`, {
      actionLabel: 'Angre',
      onAction:    () => undoDelete(id),
      duration:    UNDO_DELAY
    });
  });
}

async function commitDelete(id) {
  const pending = pendingDeletes.get(id);
  if (!pending) return;
  pendingDeletes.delete(id);

  const token = sessionStorage.getItem('vk_token');
  try {
    const res  = await fetch(SCRIPT_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({ action: 'delete', token, id })
    });
    const data = await res.json();
    if (data.error) {
      teacherData.push(pending.entry);
      setCachedData(teacherData);
      renderCurrentView();
      showAlert('Feil ved sletting: ' + data.error + '\nVurderingen er gjenopprettet.');
    }
  } catch {
    teacherData.push(pending.entry);
    setCachedData(teacherData);
    renderCurrentView();
    showAlert('Nettverksfeil under sletting. Vurderingen er gjenopprettet.');
  }
}

function undoDelete(id) {
  const pending = pendingDeletes.get(id);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingDeletes.delete(id);
  teacherData.push(pending.entry);
  setCachedData(teacherData);
  renderCurrentView();
}

function flushPendingDeletes() {
  if (pendingDeletes.size === 0) return;
  const token = sessionStorage.getItem('vk_token');
  pendingDeletes.forEach((pending, id) => {
    clearTimeout(pending.timer);
    if (token) {
      try {
        fetch(SCRIPT_URL, {
          method:  'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body:    new URLSearchParams({ action: 'delete', token, id }),
          keepalive: true
        });
      } catch {}
    }
  });
  pendingDeletes.clear();
}

// ─── Class toggles ─────────────────────────────────────────────

function renderClassToggles(selected = []) {
  const container = document.getElementById('classToggles');
  container.innerHTML = '';
  CLASS_GRADES.forEach(group => {
    const wrap = document.createElement('div');
    wrap.className = 'class-grade-group';
    const lbl = document.createElement('span');
    lbl.className = 'class-grade-label';
    lbl.textContent = group.label;
    wrap.appendChild(lbl);
    group.classes.forEach(cls => {
      const btn = document.createElement('button');
      btn.type        = 'button';
      btn.className   = 'class-toggle' + (selected.includes(cls) ? ' active' : '');
      btn.textContent = cls;
      btn.dataset.cls = cls;
      btn.addEventListener('click', () => { btn.classList.toggle('active'); scheduleConflictFetch(); });
      wrap.appendChild(btn);
    });
    container.appendChild(wrap);
  });
}

function getSelectedClasses() {
  return [...document.querySelectorAll('.class-toggle.active')].map(b => b.dataset.cls);
}

// ─── Conflict detection (computed locally) ─────────────────────

function scheduleConflictFetch() {
  clearTimeout(conflictTimer);
  conflictTimer = setTimeout(computeConflicts, 200);
}

function computeConflicts() {
  const date    = document.getElementById('modalDate').value;
  const classes = getSelectedClasses();
  if (!date || classes.length === 0) { clearConflicts(); return; }

  const weeksRange = Math.max(1, Math.min(4, parseInt(document.getElementById('conflictRange').value, 10) || 1));

  const center = new Date(date);
  const dow    = center.getDay() || 7;
  const centerMonday = new Date(center);
  centerMonday.setDate(center.getDate() - dow + 1);

  const rangeStart = new Date(centerMonday); rangeStart.setDate(centerMonday.getDate() - 7 * weeksRange);
  const rangeEnd   = new Date(centerMonday); rangeEnd.setDate(centerMonday.getDate() + 7 * (weeksRange + 1));
  const startISO = toISODate(rangeStart);
  const endISO   = toISODate(rangeEnd);

  const upperClasses = classes.map(c => c.toUpperCase());

  const matches = teacherData.filter(e => {
    if (e.id === editingId) return false;
    if (e.date < startISO || e.date >= endISO) return false;
    const entryClasses = e.classes.toUpperCase().replace(/,/g, ' ').split(/\s+/).filter(Boolean);
    return upperClasses.some(c => entryClasses.includes(c));
  });

  renderConflicts(matches, centerMonday, weeksRange);
}

function renderConflicts(entries, centerMonday, weeksRange) {
  const list    = document.getElementById('conflictList');
  const heading = document.getElementById('conflictHeading');
  const panel   = document.getElementById('conflictPanel');
  panel.hidden = false;

  const count = entries.length;
  const span = weeksRange === 1 ? 'denne, forrige og neste uke' : `±${weeksRange} uker`;
  heading.textContent = count === 0
    ? `Vurderinger ${span}`
    : `${count} vurdering${count !== 1 ? 'er' : ''} ${span}`;

  list.innerHTML = '';

  if (count === 0) {
    list.innerHTML = '<p class="no-conflicts">Ingen andre vurderinger i dette tidsrommet.</p>';
    return;
  }

  for (let i = -weeksRange; i <= weeksRange; i++) {
    const monday = new Date(centerMonday);
    monday.setDate(centerMonday.getDate() + 7 * i);
    const nextMonday = new Date(monday);
    nextMonday.setDate(monday.getDate() + 7);
    const startISO = toISODate(monday);
    const endISO   = toISODate(nextMonday);

    const weekEntries = entries.filter(e => e.date >= startISO && e.date < endISO)
                              .sort((a, b) => a.date.localeCompare(b.date));
    if (weekEntries.length === 0) continue;

    const isCurrent = i === 0;
    const label = isCurrent
      ? `Valgt uke - uke ${getWeekNumber(monday)}`
      : `Uke ${getWeekNumber(monday)}`;

    const section = document.createElement('div');
    section.className = 'conflict-week' + (isCurrent ? ' conflict-week-current' : '');

    const weekLabel       = document.createElement('p');
    weekLabel.className   = 'conflict-week-label';
    weekLabel.textContent = label;
    section.appendChild(weekLabel);

    weekEntries.forEach(e => {
      const div     = document.createElement('div');
      div.className = 'conflict-item';
      div.innerHTML = `
        <span class="conflict-date">${formatDisplayDate(e.date)}</span>
        <span class="conflict-classes">${escapeHtml(e.classes)}</span>
        <span class="conflict-subject">${escapeHtml(e.subject)}</span>
      `;
      section.appendChild(div);
    });

    list.appendChild(section);
  }
}

function clearConflicts() {
  document.getElementById('conflictPanel').hidden = true;
  document.getElementById('conflictList').innerHTML = '';
}

// ─── Confirm / Alert dialog ────────────────────────────────────

function showConfirm(message, onConfirm) {
  document.getElementById('confirmMessage').textContent  = message;
  document.getElementById('confirmCancel').hidden        = false;
  document.getElementById('confirmOk').textContent       = 'Bekreft';
  document.getElementById('confirmOverlay').classList.add('open');
  document.getElementById('confirmDialog').classList.add('open');
  document.getElementById('confirmOk').onclick = () => { closeConfirm(); onConfirm(); };
}

function showAlert(message) {
  document.getElementById('confirmMessage').textContent  = message;
  document.getElementById('confirmCancel').hidden        = true;
  document.getElementById('confirmOk').textContent       = 'OK';
  document.getElementById('confirmOverlay').classList.add('open');
  document.getElementById('confirmDialog').classList.add('open');
  document.getElementById('confirmOk').onclick = closeConfirm;
}

function closeConfirm() {
  document.getElementById('confirmOverlay').classList.remove('open');
  document.getElementById('confirmDialog').classList.remove('open');
  document.getElementById('confirmCancel').hidden  = false;
  document.getElementById('confirmOk').textContent = 'Bekreft';
  document.getElementById('confirmOk').onclick     = null;
}

// ─── Overlay & background-loading indicator ────────────────────

function showOverlay() {
  const overlay = document.getElementById('overlay');
  overlay.querySelector('.overlay-text').textContent = 'Laster…';
  overlay.querySelector('.spinner').style.display = '';
  const retryBtn = overlay.querySelector('.overlay-retry');
  if (retryBtn) retryBtn.remove();
  overlay.classList.add('active');
}

function hideOverlay() {
  document.getElementById('overlay').classList.remove('active');
}

function showOverlayError(msg) {
  const overlay = document.getElementById('overlay');
  overlay.querySelector('.spinner').style.display = 'none';
  overlay.querySelector('.overlay-text').textContent = msg;
  if (!overlay.querySelector('.overlay-retry')) {
    const btn = document.createElement('button');
    btn.className   = 'btn btn-primary overlay-retry';
    btn.textContent = 'Prøv igjen';
    btn.addEventListener('click', () => { hideOverlay(); loadData({ skipCache: true }); });
    overlay.querySelector('.overlay-inner').appendChild(btn);
  }
  overlay.classList.add('active');
}

function showBgLoading() { document.getElementById('bgLoading')?.classList.add('active'); }
function hideBgLoading() { document.getElementById('bgLoading')?.classList.remove('active'); }

// ─── Stale data signal ─────────────────────────────────────────

function scheduleStaleSignal() {
  if (staleTimer) return;
  staleTimer = setTimeout(() => {
    document.getElementById('lastUpdated')?.classList.add('stale');
    staleTimer = null;
  }, STALE_DELAY);
}

function clearStale() {
  if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; }
  document.getElementById('lastUpdated')?.classList.remove('stale');
}

// ─── Toast ─────────────────────────────────────────────────────

function showToast(message, opts = {}) {
  const toast = document.getElementById('toast');
  toast.querySelector('.toast-msg').textContent = message;
  const actionBtn = toast.querySelector('.toast-action');
  if (opts.actionLabel) {
    actionBtn.textContent = opts.actionLabel;
    actionBtn.hidden = false;
    actionBtn.onclick = () => { opts.onAction?.(); hideToast(); };
  } else {
    actionBtn.hidden = true;
    actionBtn.onclick = null;
  }
  toast.hidden = false;
  requestAnimationFrame(() => toast.classList.add('show'));
  clearTimeout(toast._timer);
  toast._timer = setTimeout(hideToast, opts.duration ?? 3000);
}

function hideToast() {
  const toast = document.getElementById('toast');
  toast.classList.remove('show');
  clearTimeout(toast._timer);
  setTimeout(() => { toast.hidden = true; }, 250);
}

// ─── Focus management & shortcuts ──────────────────────────────

function rememberFocus() { lastFocusedEl = document.activeElement; }
function restoreFocus() {
  if (lastFocusedEl && typeof lastFocusedEl.focus === 'function') {
    try { lastFocusedEl.focus(); } catch {}
  }
  lastFocusedEl = null;
}

function trapFocus(container, e) {
  const focusables = [...container.querySelectorAll(
    'button:not([disabled]):not([hidden]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )].filter(el => el.offsetParent !== null);
  if (focusables.length === 0) return;
  const first = focusables[0], last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function setupGlobalShortcuts() {
  document.addEventListener('keydown', e => {
    const modal     = document.getElementById('modal');
    const confirmEl = document.getElementById('confirmDialog');
    const panel     = document.getElementById('teacherPanel');

    if (e.key === 'Escape') {
      if (modal?.classList.contains('open'))     { attemptCloseModal(); return; }
      if (confirmEl?.classList.contains('open')) { closeConfirm(); return; }
      if (panel?.classList.contains('open'))     { closeTeacherPanel(); return; }
      return;
    }

    if (e.key === 'Tab') {
      if (modal?.classList.contains('open'))     { trapFocus(modal, e);     return; }
      if (confirmEl?.classList.contains('open')) { trapFocus(confirmEl, e); return; }
      if (panel?.classList.contains('open'))     { trapFocus(panel, e);     return; }
    }

    // Letter shortcuts: only when not typing into a field, and no modal/dialog is open.
    if (e.target.matches('input, textarea, select, [contenteditable="true"]')) return;
    if (modal?.classList.contains('open')) return;
    if (confirmEl?.classList.contains('open')) return;

    if (!sessionStorage.getItem('vk_token')) return; // not logged in
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const k = e.key.toLowerCase();
    if (k === 'n') { e.preventDefault(); openModal(); }
    else if (k === 't') { e.preventDefault(); setView('table'); }
    else if (k === 'k') { e.preventDefault(); setView('calendar'); }
    else if (k === '/') {
      e.preventDefault();
      document.querySelector('#filterClassBtns .filter-class-btn')?.focus();
    }
  });
}

// ─── Cache ─────────────────────────────────────────────────────

function getCachedData() {
  const ts = localStorage.getItem(CACHE_TS_KEY);
  if (!ts || Date.now() - Number(ts) > CACHE_TTL) return null;
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)); } catch { return null; }
}

function setCachedData(data) {
  localStorage.setItem(CACHE_KEY,    JSON.stringify(data));
  localStorage.setItem(CACHE_TS_KEY, String(Date.now()));
}

function updateStatus() {
  const ts = localStorage.getItem(CACHE_TS_KEY);
  if (!ts) return;
  document.getElementById('lastUpdated').textContent =
    'Sist oppdatert: ' + new Date(Number(ts)).toLocaleString('no');
}

// ─── Utilities ─────────────────────────────────────────────────

function getSchoolYearBounds(today) {
  const y = today.getFullYear();
  const m = today.getMonth();
  const d = today.getDate();
  const pastJun21 = m > 5 || (m === 5 && d > 21);
  if (pastJun21) return { start: `${y}-08-15`,   end: `${y + 1}-06-21` };
  return                  { start: `${y - 1}-08-15`, end: `${y}-06-21` };
}

function toISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function formatDisplayDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y}`;
}

function formatDateLong(d) {
  const days = ['Søndag','Mandag','Tirsdag','Onsdag','Torsdag','Fredag','Lørdag'];
  return `${days[d.getDay()]} ${d.getDate()}. ${d.toLocaleString('no',{month:'long'})} ${d.getFullYear()} — uke ${getWeekNumber(d)}`;
}

function getWeekNumber(d) {
  d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function capitalizeFirst(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ─── School calendar (Nes kommune iCal) ───────────────────────

const SCHOOL_TYPE_LABEL = {
  off:      'Skolefri',
  planning: 'Planleggingsdag',
  marker:   'Skoledag-markering'
};

function buildSchoolDayCard(sch) {
  const card = document.createElement('div');
  card.className = 'school-day-card school-day-' + sch.type;
  const label = document.createElement('div');
  label.className   = 'school-day-label';
  label.textContent = SCHOOL_TYPE_LABEL[sch.type] || sch.type;
  card.appendChild(label);
  sch.summaries.forEach(s => {
    const line = document.createElement('div');
    line.className   = 'school-day-summary';
    line.textContent = s;
    card.appendChild(line);
  });
  return card;
}

function applySchoolDay(td, dateKey) {
  const sch = schoolDays[dateKey];
  if (!sch) return;
  td.classList.add('school-' + sch.type);
  if (sch.summaries.length) td.title = sch.summaries.join(', ');
  if (sch.type === 'planning') {
    const badge = document.createElement('span');
    badge.className = 'school-badge';
    badge.textContent = 'P';
    td.appendChild(badge);
  }
}

function classifySchoolEvent(summary) {
  const s = (summary || '').toLowerCase();
  if (!s || s.includes('sfo')) return null;
  if (s.includes('planleggingsdag')) return 'planning';
  if (s.includes('første skoledag') || s.includes('siste skoledag')) return 'marker';
  if (
    s.includes('ferie') ||
    s.includes('himmelfartsdag') ||
    s.includes('pinsedag') ||
    s.includes('grunnlovsdag') ||
    s.includes('1.mai') || s.includes('1. mai') ||
    s.includes('skjærtorsdag') || s.includes('langfredag') || s.includes('påskedag') ||
    s.includes('julaften') || s.includes('nyttårsaften') ||
    s.includes('juledag') || s.includes('nyttårsdag')
  ) return 'off';
  return null;
}

function parseICS(text) {
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);
  const events = [];
  let current = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { current = {}; continue; }
    if (line === 'END:VEVENT')   { if (current) events.push(current); current = null; continue; }
    if (!current) continue;
    const m = line.match(/^([A-Z]+)(?:;[^:]*)?:(.*)$/);
    if (!m) continue;
    const [, key, val] = m;
    if (key === 'DTSTART')      current.dtstart = val.trim();
    else if (key === 'SUMMARY') current.summary = unescapeICS(val);
  }
  return events
    .map(e => ({ date: icsDateToISO(e.dtstart), summary: e.summary || '' }))
    .filter(e => e.date);
}

function icsDateToISO(s) {
  if (!s) return null;
  const m = s.match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function unescapeICS(s) {
  return s.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

function buildSchoolDayMap(events) {
  const priority = { off: 3, planning: 2, marker: 1 };
  const out = {};
  for (const e of events) {
    const type = classifySchoolEvent(e.summary);
    if (!type) continue;
    const existing = out[e.date];
    if (!existing) {
      out[e.date] = { type, summaries: [e.summary] };
    } else {
      if (priority[type] > priority[existing.type]) existing.type = type;
      if (!existing.summaries.includes(e.summary)) existing.summaries.push(e.summary);
    }
  }
  return out;
}

function loadCachedSchoolDays() {
  const ts = localStorage.getItem(SCHOOL_CAL_TS_KEY);
  if (!ts || Date.now() - Number(ts) > SCHOOL_CAL_TTL) return null;
  try { return JSON.parse(localStorage.getItem(SCHOOL_CAL_KEY)); } catch { return null; }
}

async function loadSchoolCalendar() {
  if (Object.keys(schoolDays).length > 0 && loadCachedSchoolDays()) return;
  try {
    const res = await fetch(SCHOOL_CAL_URL);
    if (!res.ok) return;
    const text = await res.text();
    const events = parseICS(text);
    if (events.length === 0) return;
    schoolDays = buildSchoolDayMap(events);
    localStorage.setItem(SCHOOL_CAL_KEY,    JSON.stringify(schoolDays));
    localStorage.setItem(SCHOOL_CAL_TS_KEY, String(Date.now()));
    if (currentView === 'calendar' && document.getElementById('teacherCalendar')) {
      renderTeacherCalendar();
    }
  } catch {
    // Silent — keep whatever was previously cached.
  }
}
