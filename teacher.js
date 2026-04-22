'use strict';

const SCRIPT_URL       = 'https://script.google.com/macros/s/AKfycbwsXqoLZW8RlIAwvGN1yQXgpLnB3aCbVtjrmt4X5v302Fpbd9XFsSiobBOOTC4z1q5n/exec';
const CACHE_KEY        = 'vk_teacher_data';
const CACHE_TS_KEY     = 'vk_teacher_data_ts';
const CACHE_TTL        = 60 * 60 * 1000;
const TEACHER_NAME_KEY = 'vk_teacher_name';

const CLASSES = [
  '8A','8B','8C','8D','8E','8F',
  '9A','9B','9C','9D','9E','9F',
  '10A','10B','10C','10D','10E','10F'
];

let teacherData   = [];
let editingId     = null;
let showPast      = false;
let conflictTimer = null;
let currentView    = 'table';
let filterClasses  = [];
let filterStart    = '';
let filterEnd      = '';
let panelOpenDate = null;

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
  setupDashboardListeners();
  setupModalListeners();
  setupConfirmListeners();

  setupFilterClassBtns();

  if (sessionStorage.getItem('vk_token')) {
    showDashboard();
    loadData();
  } else {
    showLogin();
  }
}

function setupLoginListeners() {
  document.getElementById('loginForm').addEventListener('submit', handleLogin);
}

function setupDashboardListeners() {
  document.getElementById('addBtn').addEventListener('click', () => openModal(null));
  document.getElementById('refreshBtn').addEventListener('click', () => loadData(true));
  document.getElementById('logoutBtn').addEventListener('click', handleLogout);
  document.getElementById('showPastToggle').addEventListener('change', e => {
    showPast = e.target.checked;
    renderCurrentView();
  });
  document.getElementById('viewTable').addEventListener('click', () => setView('table'));
  document.getElementById('viewCalendar').addEventListener('click', () => setView('calendar'));
  document.getElementById('filterStart').addEventListener('change', onFilterChange);
  document.getElementById('filterEnd').addEventListener('change', onFilterChange);
  document.getElementById('teacherPanelClose').addEventListener('click', closeTeacherPanel);
  document.getElementById('teacherPanelOverlay').addEventListener('click', closeTeacherPanel);
  document.getElementById('teacherPanelAdd').addEventListener('click', () => {
    const date = panelOpenDate;
    closeTeacherPanel();
    openModal(null, date);
  });

  // Column filters delegation on tbody handles action buttons, row clicks handle expand
  document.querySelector('#dataTable tbody').addEventListener('click', handleTableClick);
  ['cfDate','cfClass','cfSubject','cfDesc','cfTeacher'].forEach(id =>
    document.getElementById(id).addEventListener('input', debounce(onColFilterChange, 300))
  );
  document.getElementById('cfLegacy').addEventListener('change', onColFilterChange);
}

function setupModalListeners() {
  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('modalCancel').addEventListener('click', closeModal);
  document.getElementById('modalOverlay').addEventListener('click', closeModal);
  document.getElementById('modalForm').addEventListener('submit', handleSave);
  document.getElementById('modalDate').addEventListener('change', scheduleConflictFetch);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeModal(); closeTeacherPanel(); closeConfirm(); }
  });
}

function setupConfirmListeners() {
  document.getElementById('confirmCancel').addEventListener('click', closeConfirm);
  document.getElementById('confirmOverlay').addEventListener('click', closeConfirm);
}

// ─── Auth ─────────────────────────────────────────────────────

async function handleLogin(e) {
  e.preventDefault();
  const password = document.getElementById('passwordInput').value;
  const errEl    = document.getElementById('loginError');
  const btn      = document.getElementById('loginBtn');

  errEl.textContent = '';
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
  sessionStorage.removeItem('vk_token');
  teacherData = [];
  showLogin();
}

// ─── Views ────────────────────────────────────────────────────

function showLogin() {
  document.getElementById('loginView').hidden = false;
  document.getElementById('dashboard').hidden = true;
  document.getElementById('passwordInput').value = '';
  document.getElementById('loginError').textContent = '';
  document.getElementById('wrongPasswordImg').hidden = true;
}

function showDashboard() {
  document.getElementById('loginView').hidden = true;
  document.getElementById('dashboard').hidden = false;
}

// ─── Data loading ──────────────────────────────────────────────

async function loadData(force = false) {
  if (!force) {
    const cached = getCachedData();
    if (cached) {
      teacherData = cached;
      renderCurrentView();
      updateStatus();
      hideOverlay();
      return;
    }
  }

  showOverlay();
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
    hideOverlay();
  } catch (err) {
    showOverlayError('Kunne ikke laste data: ' + err.message);
  }
}

// ─── Filtering ─────────────────────────────────────────────────

function onFilterChange() {
  filterStart = document.getElementById('filterStart').value;
  filterEnd   = document.getElementById('filterEnd').value;
  renderCurrentView();
}

function setupFilterClassBtns() {
  const container = document.getElementById('filterClassBtns');
  CLASSES.forEach(cls => {
    const btn = document.createElement('button');
    btn.type        = 'button';
    btn.className   = 'filter-class-btn';
    btn.textContent = cls;
    btn.addEventListener('click', () => {
      btn.classList.toggle('active');
      filterClasses = [...document.querySelectorAll('.filter-class-btn.active')].map(b => b.textContent);
      renderCurrentView();
    });
    container.appendChild(btn);
  });
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
  return teacherData.filter(e => {
    if (!showPast && e.date < today) return false;
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
    // ── Main row ──────────────────────────────────────────────
    const tr = document.createElement('tr');
    tr.className = 'data-row';
    if (entry.date < today) tr.classList.add('past-row');
    if (entry.isLegacy)     tr.classList.add('legacy-row');

    const actionCell = entry.isLegacy
      ? `<span class="legacy-badge">Gammelt system</span>`
      : `<button class="icon-btn" title="Rediger" data-id="${escapeHtml(entry.id)}" data-action="edit">&#9998;</button>
         <button class="icon-btn icon-btn-danger" title="Slett" data-id="${escapeHtml(entry.id)}" data-action="delete">&#10005;</button>`;

    tr.innerHTML = `
      <td data-label="Dato">${formatDisplayDate(entry.date)}</td>
      <td data-label="Klasse(r)">${escapeHtml(entry.classes)}</td>
      <td data-label="Fag">${escapeHtml(entry.subject)}</td>
      <td data-label="Beskrivelse" class="desc-cell">${escapeHtml(entry.description || entry.notes || '')}</td>
      <td data-label="Lærer">${escapeHtml(entry.teacher || '')}</td>
      <td class="action-cell">${actionCell}</td>
    `;

    // ── Expand row ────────────────────────────────────────────
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
  if (action === 'edit')   openModal(id);
  if (action === 'delete') handleDelete(id);
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
  title.textContent = capitalizeFirst(monthDate.toLocaleString('no', { month: 'long', year: 'numeric' }));
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
        if (dateKey === todayKey) td.classList.add('today');

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
        td.addEventListener('click', () => openTeacherPanel(snapDate, snapEntries));
      } else {
        td.className   = 'day other-month';
        td.textContent = cursor.getDate();
      }

      tr.appendChild(td);
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  card.appendChild(table);
  return card;
}

// ─── Teacher day panel ─────────────────────────────────────────

function openTeacherPanel(date, entries) {
  panelOpenDate = toISODate(date);
  document.getElementById('teacherPanelTitle').textContent = formatDateLong(date);

  const body = document.getElementById('teacherPanelBody');
  body.innerHTML = '';

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

      if (e.isLegacy) {
        const badge = document.createElement('span');
        badge.className   = 'legacy-badge';
        badge.textContent = 'Gammelt system';
        card.appendChild(badge);
      } else {
        const actions = document.createElement('div');
        actions.className = 'ac-panel-actions';

        const editBtn = document.createElement('button');
        editBtn.className   = 'btn btn-sm btn-ghost';
        editBtn.textContent = 'Rediger';
        editBtn.addEventListener('click', () => { closeTeacherPanel(); openModal(e.id); });

        const delBtn = document.createElement('button');
        delBtn.className   = 'btn btn-sm btn-ghost-danger';
        delBtn.textContent = 'Slett';
        delBtn.addEventListener('click', () => handleDelete(e.id));

        actions.appendChild(editBtn);
        actions.appendChild(delBtn);
        card.appendChild(actions);
      }

      body.appendChild(card);
    });
  }

  document.getElementById('teacherPanelOverlay').classList.add('open');
  document.getElementById('teacherPanel').classList.add('open');
}

function closeTeacherPanel() {
  document.getElementById('teacherPanelOverlay').classList.remove('open');
  document.getElementById('teacherPanel').classList.remove('open');
  panelOpenDate = null;
}

// ─── Modal ─────────────────────────────────────────────────────

function openModal(id, defaultDate = null) {
  editingId = id || null;
  const entry = editingId ? teacherData.find(e => e.id === editingId) : null;

  document.getElementById('modalTitle').textContent     = entry ? 'Rediger vurdering' : 'Legg til vurdering';
  document.getElementById('modalDate').value            = entry ? entry.date : (defaultDate || '');
  document.getElementById('modalSubject').value         = entry ? entry.subject : '';
  document.getElementById('modalDescription').value     = entry ? (entry.description || entry.notes || '') : '';
  document.getElementById('modalTeacher').value         = entry
    ? (entry.teacher || '')
    : (localStorage.getItem(TEACHER_NAME_KEY) || '');
  document.getElementById('modalError').textContent = '';

  const selected = entry ? entry.classes.split(' ').filter(Boolean) : [];
  renderClassToggles(selected);

  clearConflicts();
  if (entry || defaultDate) scheduleConflictFetch();

  document.getElementById('modalOverlay').classList.add('open');
  document.getElementById('modal').classList.add('open');
  document.getElementById('modalDate').focus();
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
  document.getElementById('modal').classList.remove('open');
  editingId = null;
  clearTimeout(conflictTimer);
}

async function handleSave(e) {
  e.preventDefault();
  const errEl   = document.getElementById('modalError');
  const saveBtn = document.getElementById('saveBtn');
  const classes = getSelectedClasses();

  if (classes.length === 0)               { errEl.textContent = 'Velg minst én klasse.'; return; }

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

  if (payload.teacher) localStorage.setItem(TEACHER_NAME_KEY, payload.teacher);

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
    } else {
      teacherData.push(data);
    }

    setCachedData(teacherData);
    closeModal();
    renderCurrentView();
  } catch {
    errEl.textContent = 'Nettverksfeil. Prøv igjen.';
  } finally {
    saveBtn.disabled    = false;
    saveBtn.textContent = 'Lagre';
  }
}

// ─── Delete ────────────────────────────────────────────────────

function handleDelete(id) {
  const entry = teacherData.find(e => e.id === id);
  const label = entry
    ? `${formatDisplayDate(entry.date)} - ${entry.subject} (${entry.classes})`
    : id;

  showConfirm(`Vil du slette denne vurderingen?\n\n${label}`, async () => {
    const token = sessionStorage.getItem('vk_token');
    try {
      const res  = await fetch(SCRIPT_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({ action: 'delete', token, id })
      });
      const data = await res.json();

      if (data.error) { showAlert('Feil ved sletting: ' + data.error); return; }

      teacherData = teacherData.filter(e => e.id !== id);
      setCachedData(teacherData);
      closeTeacherPanel();
      renderCurrentView();
    } catch {
      showAlert('Nettverksfeil. Prøv igjen.');
    }
  });
}

// ─── Class toggles ─────────────────────────────────────────────

function renderClassToggles(selected = []) {
  const container = document.getElementById('classToggles');
  container.innerHTML = '';
  CLASSES.forEach(cls => {
    const btn = document.createElement('button');
    btn.type        = 'button';
    btn.className   = 'class-toggle' + (selected.includes(cls) ? ' active' : '');
    btn.textContent = cls;
    btn.addEventListener('click', () => { btn.classList.toggle('active'); scheduleConflictFetch(); });
    container.appendChild(btn);
  });
}

function getSelectedClasses() {
  return [...document.querySelectorAll('.class-toggle.active')].map(b => b.textContent);
}

// ─── Conflict detection ────────────────────────────────────────

function scheduleConflictFetch() {
  clearTimeout(conflictTimer);
  conflictTimer = setTimeout(fetchConflicts, 400);
}

async function fetchConflicts() {
  const date    = document.getElementById('modalDate').value;
  const classes = getSelectedClasses();
  if (!date || classes.length === 0) { clearConflicts(); return; }

  const token = sessionStorage.getItem('vk_token');
  const panel = document.getElementById('conflictPanel');
  const list  = document.getElementById('conflictList');
  panel.hidden = false;
  list.innerHTML = '<p class="conflict-loading">Sjekker…</p>';

  try {
    const res    = await fetch(`${SCRIPT_URL}?action=conflicts&token=${encodeURIComponent(token)}&date=${date}&classes=${encodeURIComponent(classes.join(' '))}`);
    const data   = await res.json();
    const filtered = Array.isArray(data) ? data.filter(e => e.id !== editingId) : [];
    renderConflicts(filtered, date);
  } catch {
    list.innerHTML = '<p class="conflict-loading">Kunne ikke laste konflikter.</p>';
  }
}

function renderConflicts(entries, dateStr) {
  const list    = document.getElementById('conflictList');
  const heading = document.getElementById('conflictHeading');
  const count   = entries.length;

  heading.textContent = count === 0
    ? 'Vurderinger denne, forrige og neste uke'
    : `${count} vurdering${count !== 1 ? 'er' : ''} denne, forrige og neste uke`;

  if (count === 0) {
    list.innerHTML = '<p class="no-conflicts">Ingen andre vurderinger i dette tidsrommet.</p>';
    return;
  }

  // Monday of the week containing the selected date
  const center = new Date(dateStr);
  const dow    = center.getDay() || 7;
  const monday = new Date(center);
  monday.setDate(center.getDate() - dow + 1);

  const prevMonday = new Date(monday); prevMonday.setDate(monday.getDate() - 7);
  const nextMonday = new Date(monday); nextMonday.setDate(monday.getDate() + 7);

  const prevMon = toISODate(prevMonday);
  const curMon  = toISODate(monday);
  const nextMon = toISODate(nextMonday);

  const prevWeek = entries.filter(e => e.date >= prevMon && e.date < curMon);
  const currWeek = entries.filter(e => e.date >= curMon  && e.date < nextMon);
  const nextWeek = entries.filter(e => e.date >= nextMon);

  list.innerHTML = '';

  function renderSection(sectionEntries, label, isCurrent) {
    if (sectionEntries.length === 0) return;
    const section     = document.createElement('div');
    section.className = 'conflict-week' + (isCurrent ? ' conflict-week-current' : '');

    const weekLabel       = document.createElement('p');
    weekLabel.className   = 'conflict-week-label';
    weekLabel.textContent = label;
    section.appendChild(weekLabel);

    sectionEntries.forEach(e => {
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

  renderSection(prevWeek, `Uke ${getWeekNumber(prevMonday)}`, false);
  renderSection(currWeek, `Valgt uke - uke ${getWeekNumber(monday)}`, true);
  renderSection(nextWeek, `Uke ${getWeekNumber(nextMonday)}`, false);
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

// ─── Overlay ───────────────────────────────────────────────────

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
    btn.addEventListener('click', () => { hideOverlay(); loadData(true); });
    overlay.querySelector('.overlay-inner').appendChild(btn);
  }
  overlay.classList.add('active');
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
