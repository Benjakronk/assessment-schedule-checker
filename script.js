'use strict';

// Update this to the new Apps Script deployment URL after deploying new_GAS.js
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwsXqoLZW8RlIAwvGN1yQXgpLnB3aCbVtjrmt4X5v302Fpbd9XFsSiobBOOTC4z1q5n/exec';

const CACHE_KEY    = 'vk_data';
const CACHE_TS_KEY = 'vk_data_ts';
const CACHE_TTL    = 60 * 60 * 1000; // 1 hour
const CLASS_KEY    = 'vk_class_selection';
const STALE_DELAY  = 10 * 60 * 1000; // mark stale after 10 min of failed background refresh

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

let allData         = [];
let selectedClasses = []; // active class filter (empty = show all)
let staleTimer      = null;
let lastFocusedEl   = null;
let schoolDays      = loadCachedSchoolDays() || {}; // ISO date -> { type, summaries }

// ─── Lifecycle ────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', init);

async function init() {
  setupListeners();
  setupClassFilterBtns();
  setDefaultDates();
  updateControlsSummary();
  loadSchoolCalendar();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  const cached = getCachedData();
  if (cached) {
    allData = cached;
    updateStatus();
    applyRememberedClass();
    render();
    hideOverlay();
    showClassModal();
    fetchAndCache({ background: true });
  } else {
    await fetchAndCache();
  }
}

function setupListeners() {
  document.getElementById('startDate').addEventListener('change', onDateInputChange);
  document.getElementById('endDate').addEventListener('change', onDateInputChange);
  document.getElementById('refreshBtn').addEventListener('click', () => fetchAndCache({ background: allData.length > 0 }));
  document.getElementById('clearClassesBtn').addEventListener('click', clearClassFilter);
  document.getElementById('jumpTodayBtn').addEventListener('click', jumpToToday);
  document.getElementById('panelClose').addEventListener('click', closePanel);
  document.getElementById('panelOverlay').addEventListener('click', closePanel);
  document.getElementById('classModalClose').addEventListener('click', () => closeClassModal(null));
  document.getElementById('classModalAll').addEventListener('click', () => closeClassModal('all'));
  document.getElementById('classModalConfirm').addEventListener('click', () => closeClassModal('confirm'));

  // Mobile collapse: outer toolbar + per-section toggles
  document.getElementById('toolbarToggle').addEventListener('click', () => {
    const controls = document.getElementById('controls');
    const open = controls.classList.toggle('toolbar-open');
    document.getElementById('toolbarToggle').setAttribute('aria-expanded', String(open));
  });
  document.querySelectorAll('#controls .section-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const section = btn.closest('.control-section');
      const open = section.classList.toggle('section-open');
      btn.setAttribute('aria-expanded', String(open));
    });
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (document.getElementById('classModal').classList.contains('open')) closeClassModal(null);
      else closePanel();
      return;
    }
    if (e.key === 'Tab') {
      const classModal = document.getElementById('classModal');
      const panel = document.getElementById('detailPanel');
      if (classModal.classList.contains('open')) trapFocus(classModal, e);
      else if (panel.classList.contains('open')) trapFocus(panel, e);
    }
  });
}

function setDefaultDates() {
  const startEl = document.getElementById('startDate');
  const endEl   = document.getElementById('endDate');
  startEl.min = endEl.min = SCHOOL_YEAR.start;
  startEl.max = endEl.max = SCHOOL_YEAR.end;

  const today        = new Date();
  const twoMonthsOut = new Date(today.getFullYear(), today.getMonth() + 2, today.getDate());
  startEl.value = clampToSchoolYear(toISODate(today));
  endEl.value   = clampToSchoolYear(toISODate(twoMonthsOut));
}

function onDateInputChange() {
  const startEl = document.getElementById('startDate');
  const endEl   = document.getElementById('endDate');
  let start = startEl.value, end = endEl.value;
  // Swap if inverted
  if (start && end && start > end) {
    startEl.value = end;
    endEl.value   = start;
    showToast('Datointervallet ble byttet om');
  }
  updateControlsSummary();
  render();
}

function updateControlsSummary() {
  const classText = selectedClasses.length === 0
    ? 'Alle klasser'
    : selectedClasses.join(', ');
  const startVal = document.getElementById('startDate').value;
  const endVal   = document.getElementById('endDate').value;
  const dateText = (startVal && endVal)
    ? `${formatShortDate(startVal)} – ${formatShortDate(endVal)}`
    : 'Ingen dato';

  const cs = document.getElementById('classSummary');
  const ds = document.getElementById('dateSummary');
  const ts = document.getElementById('toolbarSummary');
  if (cs) cs.textContent = classText;
  if (ds) ds.textContent = dateText;
  if (ts) ts.textContent = `${classText} · ${dateText}`;
}

function formatShortDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

// ─── Data fetching ────────────────────────────────────────────

async function fetchAndCache(opts = {}) {
  const { background = false } = opts;
  if (background) showBgLoading();
  else showOverlay();

  try {
    const res = await fetch(`${SCRIPT_URL}?action=public`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('Ugyldig svar fra server');
    allData = data;
    setCachedData(allData);
    updateStatus();
    clearStale();
    if (!background) applyRememberedClass();
    render();
    if (background) hideBgLoading();
    else { hideOverlay(); showClassModal(); }
  } catch (err) {
    if (background) {
      hideBgLoading();
      scheduleStaleSignal();
      // Keep showing cached data; don't disrupt the user.
    } else {
      showOverlayError('Kunne ikke laste data. Sjekk tilkoblingen og prøv igjen.');
    }
  }
}

// ─── Class filter buttons ─────────────────────────────────────

function setupClassFilterBtns() {
  const container = document.getElementById('classFilterBtns');
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
      btn.className   = 'class-filter-btn';
      btn.textContent = cls;
      btn.dataset.cls = cls;
      btn.addEventListener('click', () => {
        btn.classList.toggle('active');
        selectedClasses = [...container.querySelectorAll('.class-filter-btn.active')].map(b => b.dataset.cls);
        saveSelectedClasses();
        updateClearBtn();
        updateControlsSummary();
        render();
      });
      wrap.appendChild(btn);
    });
    container.appendChild(wrap);
  });
  updateClearBtn();
}

function syncClassFilterBtns() {
  document.querySelectorAll('#classFilterBtns .class-filter-btn').forEach(b => {
    b.classList.toggle('active', selectedClasses.includes(b.dataset.cls));
  });
  updateClearBtn();
}

function updateClearBtn() {
  document.getElementById('clearClassesBtn').hidden = selectedClasses.length === 0;
}

function clearClassFilter() {
  selectedClasses = [];
  saveSelectedClasses();
  syncClassFilterBtns();
  updateControlsSummary();
  render();
}

function applyRememberedClass() {
  const raw = localStorage.getItem(CLASS_KEY);
  if (raw === null) { selectedClasses = []; syncClassFilterBtns(); return; }
  let saved;
  try {
    const parsed = JSON.parse(raw);
    saved = Array.isArray(parsed) ? parsed : [String(parsed)];
  } catch {
    saved = [raw]; // legacy single-string format
  }
  selectedClasses = saved.map(s => String(s).toUpperCase()).filter(s => CLASSES.includes(s));
  syncClassFilterBtns();
  updateControlsSummary();
}

function saveSelectedClasses() {
  // Always write — an empty array is a valid "view all" choice and suppresses the modal.
  localStorage.setItem(CLASS_KEY, JSON.stringify(selectedClasses));
}

// ─── Class selection modal (first visit) ───────────────────────

function showClassModal() {
  if (localStorage.getItem(CLASS_KEY) !== null) return; // user has made a choice (even [] = "view all")

  const grid = document.getElementById('classModalGrid');
  grid.innerHTML = '';

  CLASS_GRADES.forEach(group => {
    const wrap = document.createElement('div');
    wrap.className = 'class-modal-group';
    const lbl = document.createElement('span');
    lbl.className = 'class-grade-label';
    lbl.textContent = group.label;
    wrap.appendChild(lbl);
    group.classes.forEach(cls => {
      const btn = document.createElement('button');
      btn.type        = 'button';
      btn.className   = 'class-modal-btn';
      btn.textContent = cls;
      btn.dataset.cls = cls;
      btn.addEventListener('click', () => {
        btn.classList.toggle('active');
        const anyActive = grid.querySelector('.class-modal-btn.active');
        document.getElementById('classModalConfirm').disabled = !anyActive;
      });
      wrap.appendChild(btn);
    });
    grid.appendChild(wrap);
  });

  document.getElementById('classModalConfirm').disabled = true;
  rememberFocus();
  document.getElementById('classModalOverlay').classList.add('open');
  document.getElementById('classModal').classList.add('open');
  document.body.classList.add('scroll-locked');
  setTimeout(() => grid.querySelector('.class-modal-btn')?.focus(), 60);
}

function closeClassModal(action) {
  document.getElementById('classModalOverlay').classList.remove('open');
  document.getElementById('classModal').classList.remove('open');
  document.body.classList.remove('scroll-locked');

  if (action === 'confirm') {
    const chosen = [...document.querySelectorAll('#classModalGrid .class-modal-btn.active')].map(b => b.dataset.cls);
    selectedClasses = chosen;
    saveSelectedClasses();
    syncClassFilterBtns();
    updateControlsSummary();
    render();
  } else if (action === 'all') {
    selectedClasses = [];
    saveSelectedClasses(); // [] sentinel — suppresses future modal opens
    syncClassFilterBtns();
    updateControlsSummary();
    render();
  }
  // action === null (X / Escape): no persistence; modal will appear on next visit.
  restoreFocus();
}

// ─── Rendering ────────────────────────────────────────────────

function render() {
  const startInput = document.getElementById('startDate').value;
  const endInput   = document.getElementById('endDate').value;
  if (!startInput || !endInput) return;

  // Compare ISO date strings directly (both are 'yyyy-mm-dd'); avoids the
  // UTC-vs-local skew of parsing them into Date objects. Range is inclusive.
  const filtered = allData.filter(item => {
    if (item.date < startInput || item.date > endInput) return false;
    if (selectedClasses.length > 0) {
      const entryClasses = item.classes.toUpperCase().replace(/,/g, ' ').split(/\s+/).filter(Boolean);
      if (!selectedClasses.some(c => entryClasses.includes(c))) return false;
    }
    return true;
  });

  renderCalendar(filtered, new Date(startInput), new Date(endInput));
}

function renderCalendar(data, startDate, endDate) {
  const container = document.getElementById('calendar');
  container.innerHTML = '';

  if (data.length === 0 && selectedClasses.length > 0) {
    container.innerHTML = '<p class="empty-state">Ingen vurderinger funnet for valgt(e) klasse(r) i denne perioden.</p>';
    return;
  }

  const byDate = {};
  data.forEach(item => {
    if (!byDate[item.date]) byDate[item.date] = [];
    byDate[item.date].push(item);
  });

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

  const name = document.createElement('span');
  name.className = 'month-name';
  name.textContent = capitalizeFirst(
    monthDate.toLocaleString('no', { month: 'long', year: 'numeric' })
  );
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
  const headerRow = thead.insertRow();
  ['Uke', 'Man', 'Tir', 'Ons', 'Tor', 'Fre', 'Lør', 'Søn'].forEach(label => {
    const th = document.createElement('th');
    th.textContent = label;
    headerRow.appendChild(th);
  });

  const tbody = table.createTBody();
  const today = toISODate(new Date());

  let cursor = new Date(year, month, 1);
  const startDow = cursor.getDay() || 7;
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
        if (d >= 5) td.classList.add('weekend');
        if (dateKey === today) td.classList.add('today');
        applySchoolDay(td, dateKey);

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
        }

        const schoolDay = schoolDays[dateKey];
        if (assessments.length > 0 || schoolDay) {
          const snapDate  = new Date(cursor);
          const snapItems = assessments.slice();
          const monthName = monthDate.toLocaleString('no', { month: 'long' });
          let label = `${cursor.getDate()}. ${monthName}`;
          if (assessments.length > 0) label += `, ${assessments.length} vurdering${assessments.length !== 1 ? 'er' : ''}`;
          if (schoolDay) label += `, ${schoolDay.summaries.join(', ')}`;
          td.tabIndex = 0;
          td.setAttribute('role', 'button');
          td.setAttribute('aria-label', label);
          td.addEventListener('click', () => openPanel(snapDate, snapItems));
          td.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPanel(snapDate, snapItems); }
          });
        }
      } else {
        td.className = 'day other-month';
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
  let todayCell = document.querySelector('.day.today');
  if (!todayCell) {
    // Today is outside the current visible range — bring it into range first.
    const todayISO = toISODate(new Date());
    if (todayISO < SCHOOL_YEAR.start || todayISO > SCHOOL_YEAR.end) {
      showToast('I dag er utenfor dette skoleåret');
      return;
    }
    setDefaultDates();
    render();
    todayCell = document.querySelector('.day.today');
  }
  todayCell?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ─── Detail panel ─────────────────────────────────────────────

function openPanel(date, assessments) {
  rememberFocus();
  document.getElementById('panelTitle').textContent = formatDateLong(date);

  const body = document.getElementById('panelBody');
  body.innerHTML = '';

  const sch = schoolDays[toISODate(date)];
  if (sch) body.appendChild(buildSchoolDayCard(sch));

  if (assessments.length === 0 && sch) {
    const note = document.createElement('p');
    note.className   = 'panel-empty';
    note.textContent = 'Ingen vurderinger denne dagen.';
    body.appendChild(note);
  }

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
  document.body.classList.add('scroll-locked');
  setTimeout(() => document.getElementById('panelClose').focus(), 60);
}

function closePanel() {
  document.getElementById('panelOverlay').classList.remove('open');
  document.getElementById('detailPanel').classList.remove('open');
  document.body.classList.remove('scroll-locked');
  restoreFocus();
}

// ─── Overlay & background-loading indicator ───────────────────

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
    btn.addEventListener('click', () => fetchAndCache());
    overlay.querySelector('.overlay-inner').appendChild(btn);
  }

  overlay.classList.add('active');
}

function showBgLoading() { document.getElementById('bgLoading')?.classList.add('active'); }
function hideBgLoading() { document.getElementById('bgLoading')?.classList.remove('active'); }

// ─── Stale data signal ────────────────────────────────────────

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

// ─── Toast ────────────────────────────────────────────────────

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

// ─── Focus management ────────────────────────────────────────

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

function getSchoolYearBounds(today) {
  const y = today.getFullYear();
  const m = today.getMonth();
  const d = today.getDate();
  const pastJun21 = m > 5 || (m === 5 && d > 21);
  if (pastJun21) return { start: `${y}-08-15`,   end: `${y + 1}-06-21` };
  return                  { start: `${y - 1}-08-15`, end: `${y}-06-21` };
}

function clampToSchoolYear(iso) {
  if (iso < SCHOOL_YEAR.start) return SCHOOL_YEAR.start;
  if (iso > SCHOOL_YEAR.end)   return SCHOOL_YEAR.end;
  return iso;
}

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
  return `${days[d.getDay()]} ${d.getDate()}. ${d.toLocaleString('no', { month: 'long' })} ${d.getFullYear()} - uke ${getWeekNumber(d)}`;
}

function capitalizeFirst(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
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
  if (!s || s.includes('sfo')) return null; // not relevant for ungdomsskole
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
  return null; // unknown summary — leave un-styled
}

function parseICS(text) {
  const unfolded = text.replace(/\r?\n[ \t]/g, ''); // unfold continuation lines
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
  // Already have a fresh cached copy: render uses it directly. Otherwise, fetch silently.
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
    render(); // re-render to apply newly-loaded markers
  } catch {
    // Silent — we keep whatever was previously cached.
  }
}
