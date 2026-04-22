'use strict';

// Update this to the new Apps Script deployment URL after deploying new_GAS.js
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwsXqoLZW8RlIAwvGN1yQXgpLnB3aCbVtjrmt4X5v302Fpbd9XFsSiobBOOTC4z1q5n/exec';

const CACHE_KEY    = 'vk_data';
const CACHE_TS_KEY = 'vk_data_ts';
const CACHE_TTL    = 60 * 60 * 1000; // 1 hour

let allData    = [];
let searchTerm = '';

// ─── Lifecycle ────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', init);

async function init() {
  setupListeners();
  setDefaultDates();

  const cached = getCachedData();
  if (cached) {
    allData = cached;
    updateStatus();
    render();
    hideOverlay();
  } else {
    await fetchAndCache();
  }
}

function setupListeners() {
  document.getElementById('classSearch').addEventListener('input', debounce(onSearchChange, 300));
  document.getElementById('startDate').addEventListener('change', render);
  document.getElementById('endDate').addEventListener('change', render);
  document.getElementById('refreshBtn').addEventListener('click', () => fetchAndCache(true));
  document.getElementById('panelClose').addEventListener('click', closePanel);
  document.getElementById('panelOverlay').addEventListener('click', closePanel);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closePanel(); });
}

function setDefaultDates() {
  const today         = new Date();
  const twoMonthsOut  = new Date(today.getFullYear(), today.getMonth() + 2, today.getDate());
  document.getElementById('startDate').valueAsDate = today;
  document.getElementById('endDate').valueAsDate   = twoMonthsOut;
}

// ─── Data fetching ────────────────────────────────────────────

async function fetchAndCache(force = false) {
  showOverlay();
  try {
    const res = await fetch(`${SCRIPT_URL}?action=public`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('Ugyldig svar fra server');
    allData = data;
    setCachedData(allData);
    updateStatus();
    render();
    hideOverlay();
  } catch (err) {
    showOverlayError('Kunne ikke laste data. Sjekk tilkoblingen og prøv igjen.');
  }
}

// ─── Rendering ────────────────────────────────────────────────

function onSearchChange() {
  searchTerm = document.getElementById('classSearch').value.trim().toUpperCase();
  render();
}

function render() {
  const startInput = document.getElementById('startDate').value;
  const endInput   = document.getElementById('endDate').value;
  if (!startInput || !endInput) return;

  const startDate = new Date(startInput);
  const endDate   = new Date(endInput);
  endDate.setHours(23, 59, 59);

  const filtered = allData.filter(item => {
    const d = new Date(item.date);
    if (d < startDate || d > endDate) return false;
    if (searchTerm && !item.classes.toUpperCase().includes(searchTerm)) return false;
    return true;
  });

  renderCalendar(filtered, startDate, endDate);
}

function renderCalendar(data, startDate, endDate) {
  const container = document.getElementById('calendar');
  container.innerHTML = '';

  if (data.length === 0 && searchTerm) {
    container.innerHTML = '<p class="empty-state">Ingen vurderinger funnet for denne klassen i valgt periode.</p>';
    return;
  }

  // Build date → assessments[] lookup
  const byDate = {};
  data.forEach(item => {
    if (!byDate[item.date]) byDate[item.date] = [];
    byDate[item.date].push(item);
  });

  // Iterate month by month
  let cursor    = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  const endMonth = new Date(endDate.getFullYear(), endDate.getMonth(), 1);

  while (cursor <= endMonth) {
    container.appendChild(buildMonthCard(cursor, byDate));
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }
}

function buildMonthCard(monthDate, byDate) {
  const year  = monthDate.getFullYear();
  const month = monthDate.getMonth();

  const card = document.createElement('section');
  card.className = 'month-card';

  const title = document.createElement('h2');
  title.className = 'month-title';
  title.textContent = capitalizeFirst(
    monthDate.toLocaleString('no', { month: 'long', year: 'numeric' })
  );
  card.appendChild(title);

  const table = document.createElement('table');
  table.className = 'cal-table';

  // Header row
  const thead = table.createTHead();
  const headerRow = thead.insertRow();
  ['Uke', 'Man', 'Tir', 'Ons', 'Tor', 'Fre', 'Lør', 'Søn'].forEach(label => {
    const th = document.createElement('th');
    th.textContent = label;
    headerRow.appendChild(th);
  });

  // Body rows
  const tbody = table.createTBody();
  const today = toISODate(new Date());

  // Start from Monday of the week containing the 1st
  let cursor = new Date(year, month, 1);
  const startDow = cursor.getDay() || 7; // Mon=1 … Sun=7
  cursor.setDate(cursor.getDate() - startDow + 1);

  const lastDayOfMonth = new Date(year, month + 1, 0).getDate();
  const weeks = Math.ceil((lastDayOfMonth + startDow - 1) / 7);

  for (let w = 0; w < weeks; w++) {
    const tr = tbody.insertRow();

    const weekTd = document.createElement('td');
    weekTd.className = 'week-num';
    weekTd.textContent = getWeekNumber(cursor);
    tr.appendChild(weekTd);

    for (let d = 0; d < 7; d++) {
      const td = document.createElement('td');

      if (cursor.getMonth() === month) {
        const dateKey     = toISODate(cursor);
        const assessments = byDate[dateKey] || [];

        td.className = 'day';
        if (dateKey === today) td.classList.add('today');

        const num = document.createElement('span');
        num.className = 'day-num';
        num.textContent = cursor.getDate();
        td.appendChild(num);

        if (assessments.length > 0) {
          td.classList.add('has-assessments');

          const dotsWrap = document.createElement('span');
          dotsWrap.className = 'dots';
          const dotCount = Math.min(assessments.length, 4);
          for (let i = 0; i < dotCount; i++) {
            const dot = document.createElement('span');
            dot.className = 'dot';
            dotsWrap.appendChild(dot);
          }
          td.appendChild(dotsWrap);

          // Snapshot loop variables for the click handler
          const snapDate = new Date(cursor);
          const snapItems = assessments.slice();
          td.addEventListener('click', () => openPanel(snapDate, snapItems));
        }
      } else {
        td.className = 'day other-month';
        td.textContent = cursor.getDate();
      }

      tr.appendChild(td);
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  card.appendChild(table);
  return card;
}

// ─── Detail panel ─────────────────────────────────────────────

function openPanel(date, assessments) {
  document.getElementById('panelTitle').textContent = formatDateLong(date);

  const body = document.getElementById('panelBody');
  body.innerHTML = '';

  assessments.forEach(a => {
    const card = document.createElement('div');
    card.className = 'assessment-card';

    const subject = document.createElement('div');
    subject.className = 'ac-subject';
    subject.textContent = a.subject;

    const classes = document.createElement('div');
    classes.className = 'ac-classes';
    classes.textContent = a.classes;

    card.appendChild(subject);
    card.appendChild(classes);

    if (a.description || a.notes) {
      const desc = document.createElement('div');
      desc.className = 'ac-desc';
      desc.textContent = a.description || a.notes;
      card.appendChild(desc);
    }

    if (a.teacher) {
      const teacher = document.createElement('div');
      teacher.className = 'ac-teacher';
      teacher.textContent = a.teacher;
      card.appendChild(teacher);
    }

    body.appendChild(card);
  });

  document.getElementById('panelOverlay').classList.add('open');
  document.getElementById('detailPanel').classList.add('open');
}

function closePanel() {
  document.getElementById('panelOverlay').classList.remove('open');
  document.getElementById('detailPanel').classList.remove('open');
}

// ─── Overlay ──────────────────────────────────────────────────

function showOverlay() {
  const overlay = document.getElementById('overlay');
  overlay.querySelector('.overlay-text').textContent = 'Laster...';
  overlay.querySelector('.spinner').style.display = '';
  const existingBtn = overlay.querySelector('.overlay-retry');
  if (existingBtn) existingBtn.remove();
  overlay.classList.add('active');
}

function hideOverlay() {
  document.getElementById('overlay').classList.remove('active');
}

function showOverlayError(msg) {
  const overlay  = document.getElementById('overlay');
  const spinner  = overlay.querySelector('.spinner');
  const textEl   = overlay.querySelector('.overlay-text');

  spinner.style.display = 'none';
  textEl.textContent = msg;

  if (!overlay.querySelector('.overlay-retry')) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary overlay-retry';
    btn.textContent = 'Prøv igjen';
    btn.addEventListener('click', () => fetchAndCache(true));
    overlay.querySelector('.overlay-inner').appendChild(btn);
  }

  overlay.classList.add('active');
}

// ─── Cache ────────────────────────────────────────────────────

function getCachedData() {
  const ts = localStorage.getItem(CACHE_TS_KEY);
  if (!ts || Date.now() - Number(ts) > CACHE_TTL) return null;
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY));
  } catch {
    return null;
  }
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

// ─── Utilities ────────────────────────────────────────────────

function toISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getWeekNumber(d) {
  d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function formatDateLong(d) {
  const days = ['Søndag', 'Mandag', 'Tirsdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lørdag'];
  return `${days[d.getDay()]} ${d.getDate()}. ${d.toLocaleString('no', { month: 'long' })} ${d.getFullYear()} — uke ${getWeekNumber(d)}`;
}

function capitalizeFirst(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
