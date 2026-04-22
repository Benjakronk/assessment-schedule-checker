'use strict';

// Update this to the new Apps Script deployment URL after deploying new_GAS.js
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwsXqoLZW8RlIAwvGN1yQXgpLnB3aCbVtjrmt4X5v302Fpbd9XFsSiobBOOTC4z1q5n/exec';

const CACHE_KEY       = 'vk_teacher_data';
const CACHE_TS_KEY    = 'vk_teacher_data_ts';
const CACHE_TTL       = 60 * 60 * 1000; // 1 hour
const TEACHER_NAME_KEY = 'vk_teacher_name';

const CLASSES = [
  '8A','8B','8C','8D','8E','8F',
  '9A','9B','9C','9D','9E','9F',
  '10A','10B','10C','10D','10E','10F'
];

let teacherData  = [];
let editingId    = null;
let showPast     = false;
let conflictTimer = null;

// ─── Init ─────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', init);

function init() {
  setupLoginListeners();
  setupDashboardListeners();
  setupModalListeners();

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
    renderTable();
  });
}

function setupModalListeners() {
  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('modalCancel').addEventListener('click', closeModal);
  document.getElementById('modalOverlay').addEventListener('click', closeModal);
  document.getElementById('modalForm').addEventListener('submit', handleSave);
  document.getElementById('modalDate').addEventListener('change', scheduleConflictFetch);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
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
    } else {
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
      renderTable();
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
    renderTable();
    updateStatus();
    hideOverlay();
  } catch (err) {
    showOverlayError('Kunne ikke laste data: ' + err.message);
  }
}

// ─── Table rendering ───────────────────────────────────────────

function renderTable() {
  const tbody = document.querySelector('#dataTable tbody');
  tbody.innerHTML = '';

  const today = toISODate(new Date());
  const rows  = teacherData
    .filter(e => showPast || e.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (rows.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="6" class="empty-cell">Ingen vurderinger å vise.</td>`;
    tbody.appendChild(tr);
    return;
  }

  rows.forEach(entry => {
    const tr        = document.createElement('tr');
    const isPast    = entry.date < today;
    if (isPast) tr.classList.add('past-row');

    tr.innerHTML = `
      <td data-label="Dato">${formatDisplayDate(entry.date)}</td>
      <td data-label="Klasse(r)">${escapeHtml(entry.classes)}</td>
      <td data-label="Fag">${escapeHtml(entry.subject)}</td>
      <td data-label="Beskrivelse" class="desc-cell">${escapeHtml(entry.description || entry.notes || '')}</td>
      <td data-label="Lærer">${escapeHtml(entry.teacher || '')}</td>
      <td class="action-cell">
        <button class="icon-btn" title="Rediger" data-id="${escapeHtml(entry.id)}" data-action="edit">&#9998;</button>
        <button class="icon-btn icon-btn-danger" title="Slett" data-id="${escapeHtml(entry.id)}" data-action="delete">&#10005;</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  // Delegate row actions to avoid inline handlers (avoids XSS via id)
  tbody.addEventListener('click', handleTableClick);
}

function handleTableClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { id, action } = btn.dataset;
  if (action === 'edit')   openModal(id);
  if (action === 'delete') handleDelete(id);
}

// ─── Modal ─────────────────────────────────────────────────────

function openModal(id) {
  editingId = id || null;
  const entry = editingId ? teacherData.find(e => e.id === editingId) : null;

  document.getElementById('modalTitle').textContent = entry ? 'Rediger vurdering' : 'Legg til vurdering';
  document.getElementById('modalDate').value        = entry ? entry.date : '';
  document.getElementById('modalSubject').value     = entry ? entry.subject : '';
  document.getElementById('modalDescription').value = entry ? (entry.description || entry.notes || '') : '';
  document.getElementById('modalTeacher').value     = entry
    ? (entry.teacher || '')
    : (localStorage.getItem(TEACHER_NAME_KEY) || '');
  document.getElementById('modalError').textContent = '';

  const selected = entry ? entry.classes.split(' ').filter(Boolean) : [];
  renderClassToggles(selected);

  clearConflicts();
  if (entry) scheduleConflictFetch();

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

  if (classes.length === 0) { errEl.textContent = 'Velg minst én klasse.'; return; }

  const payload = {
    date:        document.getElementById('modalDate').value,
    subject:     document.getElementById('modalSubject').value.trim(),
    classes:     classes.join(' '),
    description: document.getElementById('modalDescription').value.trim(),
    teacher:     document.getElementById('modalTeacher').value.trim()
  };

  if (!payload.date)    { errEl.textContent = 'Dato er påkrevd.'; return; }
  if (!payload.subject) { errEl.textContent = 'Fag er påkrevd.'; return; }

  // Remember teacher name for next time
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
      if (idx !== -1) {
        teacherData[idx] = {
          ...teacherData[idx],
          ...payload,
          notes: payload.description // keep alias in sync
        };
      }
    } else {
      teacherData.push(data);
    }

    setCachedData(teacherData);
    renderTable();
    closeModal();
  } catch {
    errEl.textContent = 'Nettverksfeil. Prøv igjen.';
  } finally {
    saveBtn.disabled    = false;
    saveBtn.textContent = 'Lagre';
  }
}

// ─── Delete ────────────────────────────────────────────────────

async function handleDelete(id) {
  const entry = teacherData.find(e => e.id === id);
  const label = entry
    ? `${formatDisplayDate(entry.date)} — ${entry.subject} (${entry.classes})`
    : id;

  if (!confirm(`Vil du slette denne vurderingen?\n\n${label}`)) return;

  const token = sessionStorage.getItem('vk_token');
  try {
    const res  = await fetch(SCRIPT_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({ action: 'delete', token, id })
    });
    const data = await res.json();

    if (data.error) { alert('Feil ved sletting: ' + data.error); return; }

    teacherData = teacherData.filter(e => e.id !== id);
    setCachedData(teacherData);
    renderTable();
  } catch {
    alert('Nettverksfeil. Prøv igjen.');
  }
}

// ─── Class toggles ─────────────────────────────────────────────

function renderClassToggles(selected = []) {
  const container = document.getElementById('classToggles');
  container.innerHTML = '';
  CLASSES.forEach(cls => {
    const btn = document.createElement('button');
    btn.type      = 'button';
    btn.className = 'class-toggle' + (selected.includes(cls) ? ' active' : '');
    btn.textContent = cls;
    btn.addEventListener('click', () => {
      btn.classList.toggle('active');
      scheduleConflictFetch();
    });
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

  const token  = sessionStorage.getItem('vk_token');
  const panel  = document.getElementById('conflictPanel');
  const list   = document.getElementById('conflictList');
  panel.hidden = false;
  list.innerHTML = '<p class="conflict-loading">Sjekker…</p>';

  try {
    const url  = `${SCRIPT_URL}?action=conflicts&token=${encodeURIComponent(token)}&date=${date}&classes=${encodeURIComponent(classes.join(' '))}`;
    const res  = await fetch(url);
    const data = await res.json();

    // Exclude the entry currently being edited from conflicts
    const filtered = Array.isArray(data) ? data.filter(e => e.id !== editingId) : [];
    renderConflicts(filtered);
  } catch {
    list.innerHTML = '<p class="conflict-loading">Kunne ikke laste konflikter.</p>';
  }
}

function renderConflicts(entries) {
  const list = document.getElementById('conflictList');
  if (entries.length === 0) {
    list.innerHTML = '<p class="no-conflicts">Ingen andre vurderinger i dette tidsrommet.</p>';
    return;
  }
  list.innerHTML = '';
  entries.forEach(e => {
    const div       = document.createElement('div');
    div.className   = 'conflict-item';
    div.innerHTML   = `
      <span class="conflict-date">${formatDisplayDate(e.date)}</span>
      <span class="conflict-classes">${escapeHtml(e.classes)}</span>
      <span class="conflict-subject">${escapeHtml(e.subject)}</span>
    `;
    list.appendChild(div);
  });
}

function clearConflicts() {
  document.getElementById('conflictPanel').hidden = true;
  document.getElementById('conflictList').innerHTML = '';
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
    const btn       = document.createElement('button');
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
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDisplayDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y}`;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
