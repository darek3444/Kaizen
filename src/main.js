import './style.css';
import { supabase, isRecoveryRedirect } from './supabase.js';
import * as store from './store.js';
import { dialog, confirmDialog, toast } from './ui.js';
import * as alarm from './alarm.js';

const $ = (sel, root) => (root || document).querySelector(sel);

// ---------- helpers ----------
function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function uid(prefix) {
  return `${prefix}-${crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2)}`;
}
// first web address in a block of text (used to put a ↗ shortcut on the task row)
function firstUrl(text) {
  // full URLs, www.…, or bare domains followed by a path (docs.google.com/…)
  const m = (text || '').match(/(?:https?:\/\/|www\.)[^\s<>"']+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/[^\s<>"']*/i);
  return m ? m[0].replace(/[.,;:!?)\]]+$/, '') : '';
}
function normalizeUrl(url) {
  url = (url || '').trim();
  if (!url) return '';
  return /^https?:\/\//i.test(url) ? url : 'https://' + url;
}
function countLines(text) {
  return (text || '').split('\n').filter((l) => l.trim() && l.trim() !== '-').length;
}
// Runs a DOM update as a View Transition (smooth morph/crossfade handled by the
// browser; styled in style.css by `type`). Falls back to an instant update.
function withTransition(update, type = '') {
  if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) return update();
  const root = document.documentElement;
  root.dataset.vt = type;
  const t = document.startViewTransition(update);
  t.finished.finally(() => { if (root.dataset.vt === type) delete root.dataset.vt; });
}
function autosize(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

// ---------- state ----------
const DEFAULT_DOMAINS = ['Rutyna', 'Ważne', 'Inne'];
const RECURRING_DOMAIN = 'Rutyna';
const TITLE_FIELDS = ['ritual', 'sprint', 'tasks', 'calendar', 'note', 'week'];

let TODAY = todayKey();
let dailyLog = {};
let tasks = [];
let config = {};

const saveLog = () => store.set('daily-log', dailyLog);
const saveTasks = () => store.set('tasks', tasks);
const saveConfig = () => store.set('config', config);
const findTask = (id) => tasks.find((t) => t.id === id);

function getDay(dateKey) {
  const day = (dailyLog[dateKey] ||= {});
  day.sprints ||= [];
  day.note ??= '';
  return day;
}

function loadState() {
  dailyLog = store.get('daily-log', {}) || {};
  tasks = store.get('tasks', []) || [];
  config = store.get('config', {}) || {};
  config.domains ||= DEFAULT_DOMAINS.slice();
  if (!config.domains.includes(RECURRING_DOMAIN)) config.domains.unshift(RECURRING_DOMAIN);
  config.titles ||= {};
  if (config.titles.h1 === 'Rytuał') config.titles.h1 = 'Kaizen'; // app was renamed
  config.recurringTasks ??= [];
  migrateLegacy();
  config.mode ||= 'advanced';
  config.micro ??= '';
  config.weekNotes ||= {};

  let changed = dedupeRecurringTasks();
  changed = ensureRecurringTasksForToday() || changed;
  if (changed) {
    saveConfig();
    saveTasks();
  }
}

// One-time cleanups for data created by older versions:
// - drops the preset morning/evening routines (open copies too; finished ones stay in history)
// - moves the separate per-task link into the task's steps
const LEGACY_ROUTINES = ['rec-morning', 'rec-evening'];
function migrateLegacy() {
  let changed = false;
  if (!config.presetRoutinesRemoved) {
    config.recurringTasks = config.recurringTasks.filter((r) => !LEGACY_ROUTINES.includes(r.id));
    tasks = tasks.filter((t) => !(LEGACY_ROUTINES.includes(t.recurringId) && !t.done));
    config.presetRoutinesRemoved = true;
    changed = true;
  }
  tasks.forEach((t) => {
    if (!('link' in t) && !('wantsLink' in t)) return;
    if (t.link && !(t.notes || '').includes(t.link)) t.notes = (t.notes ? t.notes.replace(/\s*$/, '\n') : '') + '- ' + t.link;
    delete t.link;
    delete t.wantsLink;
    changed = true;
  });
  if (changed) {
    saveConfig();
    saveTasks();
  }
}

function ensureRecurringTasksForToday() {
  let changed = false;
  config.recurringTasks.forEach((rt) => {
    // an unfinished copy from a previous day carries over instead of duplicating
    if (tasks.some((t) => t.recurringId === rt.id && (!t.done || t.createdAt === TODAY))) return;
    tasks.push({ id: uid('task'), text: rt.text, domain: RECURRING_DOMAIN, notes: rt.notes || '', recurringId: rt.id, done: false, createdAt: TODAY });
    changed = true;
  });
  return changed;
}

// merges recurring templates that share the same text and drops duplicate copies
function dedupeRecurringTasks() {
  let changed = false;
  const seenText = new Map();
  const idRemap = {};
  config.recurringTasks = config.recurringTasks.filter((rt) => {
    const key = rt.text.trim().toLowerCase();
    if (seenText.has(key)) {
      idRemap[rt.id] = seenText.get(key);
      changed = true;
      return false;
    }
    seenText.set(key, rt.id);
    return true;
  });
  tasks.forEach((t) => {
    if (t.recurringId && idRemap[t.recurringId]) {
      t.recurringId = idRemap[t.recurringId];
      changed = true;
    }
  });
  const groups = {};
  tasks.forEach((t) => {
    if (t.recurringId) (groups[t.recurringId + '|' + t.createdAt] ||= []).push(t);
  });
  const remove = new Set();
  Object.values(groups).forEach((list) => {
    if (list.length < 2) return;
    changed = true;
    const keep = list.find((x) => x.done) || list[0];
    list.forEach((x) => x.id !== keep.id && remove.add(x.id));
  });
  if (remove.size) tasks = tasks.filter((t) => !remove.has(t.id));
  return changed;
}

function renderAll() {
  $('#kz-today').textContent = new Date().toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long' });
  applyTitles();
  applyMode();
  renderDomainSelect();
  renderDomainManage();
  renderTasks();
  renderRitual();
  renderStreak();
  renderSprintLog();
  renderDayNote();
  renderCalendar();
  renderWeek();
}

// rolls the app over to a new day when it's left open past midnight
function checkDayRollover() {
  const key = todayKey();
  if (key === TODAY) return;
  TODAY = key;
  calSelected = TODAY;
  if (ensureRecurringTasksForToday()) saveTasks();
  renderAll();
}

// ---------- routing ----------
const ROUTES = { '#kalendarz': 'calendar', '#tydzien': 'week' };
const ROUTE_TITLES = { calendar: 'Kalendarz', week: 'Tydzień' };
function currentRoute() {
  return ROUTES[location.hash.split('?')[0]] || 'day';
}
function applyRoute() {
  const route = currentRoute();
  $('#kz-daily-view').hidden = route !== 'day';
  $('#kz-calendar-view').hidden = route !== 'calendar';
  $('#kz-week-view').hidden = route !== 'week';
  document.querySelectorAll('.kz-day-only').forEach((el) => (el.hidden = route !== 'day'));
  $('#kz-header-back-link').hidden = route === 'day';
  $('#kz-today').hidden = route !== 'day';
  if (route === 'calendar') renderCalendar();
  if (route === 'week') {
    weekStart = mondayOf(new Date());
    renderWeek();
  }
  updateTabTitle();
  window.scrollTo(0, 0);
}
function updateTabTitle() {
  const base = $('#kz-h1').textContent.trim() || 'Kaizen';
  const route = currentRoute();
  if (alarm.isRinging()) document.title = '⏰ Czas minął!';
  else if (route !== 'day') document.title = `${base} · ${ROUTE_TITLES[route]}`;
  else document.title = timer.running ? `${timerLabel()} · ${base}` : base;
}

// ---------- titles ----------
function applyTitles() {
  $('#kz-h1').textContent = config.titles.h1 || 'Kaizen';
  TITLE_FIELDS.forEach((key) => {
    if (config.titles[key]) $('#kz-t-' + key).value = config.titles[key];
  });
}
function bindTitles() {
  const h1 = $('#kz-h1');
  h1.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); h1.blur(); }
  });
  h1.addEventListener('blur', () => {
    config.titles.h1 = h1.textContent.trim() || 'Kaizen';
    h1.textContent = config.titles.h1;
    saveConfig();
    updateTabTitle();
  });
  TITLE_FIELDS.forEach((key) => {
    $('#kz-t-' + key).addEventListener('change', (e) => {
      config.titles[key] = e.target.value;
      saveConfig();
    });
  });
}

// ---------- day note ----------
function renderDayNote() {
  const el = $('#kz-day-note');
  if (document.activeElement !== el) el.value = getDay(TODAY).note;
}
function bindDayNote() {
  let t;
  $('#kz-day-note').addEventListener('input', (e) => {
    getDay(TODAY).note = e.target.value;
    $('#kz-note-saved').textContent = 'zapisywanie...';
    clearTimeout(t);
    t = setTimeout(() => {
      saveLog();
      $('#kz-note-saved').textContent = 'zapisano';
    }, 500);
  });
}

// ---------- streak ----------
// consecutive days with a sprint or completed task; today doesn't break the
// streak until it's over
function renderStreak() {
  const active = new Set();
  Object.entries(dailyLog).forEach(([d, v]) => v.sprints?.length && active.add(d));
  tasks.forEach((t) => t.done && t.completedAt && active.add(t.completedAt));
  const cursor = new Date();
  if (!active.has(todayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (active.has(todayKey(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  $('#kz-streak-display').textContent = streak > 0 ? `passa: ${streak} ${streak === 1 ? 'dzień' : 'dni'}` : '';
}

// ---------- timer ----------
// Two modes: Pomodoro counts down a fixed block; Flow counts up with no limit,
// for hyperfocus days. Running state lives in localStorage (per device, not
// synced) so the timer survives reloads and mobile browsers killing the tab.
const TIMER_KEY = 'kz-timer';
const CIRC = 2 * Math.PI * 66;
const WARN_THRESHOLD_SEC = 60;
const FLOW_RING_SEC = 25 * 60; // flow ring fills once per 25 minutes
const timer = {
  mode: 'pomodoro', lenMin: 45, remaining: 45 * 60, endAt: null,
  flowAccum: 0, flowStart: null, running: false, handle: null,
};
const MODE_HINTS = {
  pomodoro: 'Stały blok z alarmem na końcu.',
  flow: 'Bez limitu — pracujesz, dopóki płynie. Kończysz, kiedy chcesz.',
};

function fmt(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${m}:${s}` : `${m}:${s}`;
}
function fmtMinutes(min) {
  const h = Math.floor(min / 60);
  return h ? `${h} h ${min % 60} min` : `${min} min`;
}
function elapsedSec() {
  if (timer.mode === 'flow') return timer.flowAccum + (timer.flowStart ? (Date.now() - timer.flowStart) / 1000 : 0);
  return timer.lenMin * 60 - timer.remaining;
}
function hasProgress() {
  return timer.running || elapsedSec() >= 1;
}
function persistTimer() {
  try {
    localStorage.setItem(TIMER_KEY, JSON.stringify({
      mode: timer.mode, lenMin: timer.lenMin, remaining: timer.remaining, endAt: timer.endAt,
      flowAccum: timer.flowAccum, flowStart: timer.flowStart,
      task: $('#kz-sprint-task').value, taskId: $('#kz-sprint-task-id').value,
    }));
  } catch {}
}
function syncRemaining() {
  if (timer.mode === 'pomodoro' && timer.running && timer.endAt) {
    timer.remaining = Math.max(0, Math.round((timer.endAt - Date.now()) / 1000));
  }
}
function timerLabel() {
  return fmt(timer.mode === 'flow' ? elapsedSec() : timer.remaining);
}
function updateDial() {
  const display = $('#kz-timer-display');
  const progress = $('#kz-dial-progress');
  display.textContent = timerLabel();
  const frac = timer.mode === 'flow'
    ? (elapsedSec() % FLOW_RING_SEC) / FLOW_RING_SEC
    : 1 - timer.remaining / (timer.lenMin * 60);
  progress.setAttribute('stroke-dashoffset', CIRC * Math.max(0, Math.min(1, 1 - frac)));
  const warn = timer.mode === 'pomodoro' && timer.running && timer.remaining <= WARN_THRESHOLD_SEC && timer.remaining > 0;
  progress.classList.toggle('warn', warn);
  display.classList.toggle('warn', warn);
  $('#kz-timer-start').textContent = timer.running ? 'Pauza' : hasProgress() ? 'Wznów' : 'Start';
  $('#kz-timer-save').textContent = timer.mode === 'flow' ? 'Zakończ blok' : 'Zapisz blok';
  updateTabTitle();
}
function renderTimerMode() {
  const seg = $('#kz-timer-mode');
  seg.dataset.active = timer.mode;
  seg.querySelectorAll('[data-mode]').forEach((b) => {
    b.setAttribute('aria-selected', String(b.dataset.mode === timer.mode));
    b.disabled = hasProgress() && b.dataset.mode !== timer.mode;
  });
  seg.title = hasProgress() ? 'Zakończ albo zresetuj blok, żeby zmienić tryb' : '';
  $('#kz-timer-mode-hint').textContent = MODE_HINTS[timer.mode];
  $('#kz-len-row').hidden = timer.mode === 'flow';
  if ($('#kz-notify-hint')) renderNotifyHint();
}
function setLength(min) {
  timer.lenMin = min;
  timer.remaining = min * 60;
  $('#kz-len-slider-val').textContent = min + ' min';
  if (min >= 1 && min <= 60) $('#kz-len-slider').value = min;
  persistTimer();
  updateDial();
}
function pauseTimer() {
  alarm.disarm();
  clearTimeout(timer.handle);
  timer.handle = null;
  if (timer.mode === 'flow' && timer.flowStart) {
    timer.flowAccum += (Date.now() - timer.flowStart) / 1000;
    timer.flowStart = null;
  }
  syncRemaining();
  timer.running = false;
  timer.endAt = null;
}
function resetTimer() {
  pauseTimer();
  timer.remaining = timer.lenMin * 60;
  timer.flowAccum = 0;
  persistTimer();
  updateDial();
  renderTimerMode();
}
function finishBlock(minutes) {
  logSprint(minutes);
  resetTimer();
}
function tick() {
  if (!timer.running) return;
  syncRemaining();
  if (timer.mode === 'pomodoro' && (timer.remaining <= 0 || timer.endAt - Date.now() < 1000)) {
    // with several tabs open, the first one to get here logs the block; the others
    // see the saved timer already reset and just follow
    if (readSavedTimer()?.endAt !== timer.endAt || !claimFinishedBlock(timer.endAt)) {
      // another tab is handling it: reset locally without logging or persisting
      clearTimeout(timer.handle);
      timer.handle = null;
      timer.running = false;
      timer.endAt = null;
      timer.remaining = timer.lenMin * 60;
      alarm.disarm();
      updateDial();
      renderTimerMode();
      return;
    }
    // ring first so the already-playing pre-scheduled chime isn't cut and restarted
    startAlarm();
    finishBlock(timer.lenMin);
    return;
  }
  updateDial();
}
// aligns each tick to the next wall-clock second instead of drifting
function scheduleTick() {
  if (!timer.running) return;
  timer.handle = setTimeout(() => {
    tick();
    scheduleTick();
  }, 1000 - (Date.now() % 1000));
}
function startTimer() {
  timer.running = true;
  if (timer.mode === 'flow') timer.flowStart = Date.now();
  else {
    timer.endAt = Date.now() + timer.remaining * 1000;
    alarm.arm(timer.endAt);
  }
  persistTimer();
  scheduleTick();
  updateDial();
  renderTimerMode();
}

// open tasks you can attach a block to; the block's time then counts toward that task
function renderSprintTaskSelect() {
  const sel = $('#kz-sprint-task-id');
  const current = sel.value || sel.dataset.restore || '';
  const open = sortTasks(tasks.filter((t) => !t.done && !t.recurringId));
  sel.innerHTML = '<option value="">— bez przypisanego zadania —</option>' +
    open.map((t) => `<option value="${t.id}">${t.id === getDay(TODAY).highlightId ? '★ ' : ''}${escapeHtml(t.text)}</option>`).join('');
  sel.value = open.some((t) => t.id === current) ? current : '';
  delete sel.dataset.restore;
}

// first tab to mark this block's end time as handled wins (tabs tick on the same second)
function claimFinishedBlock(endAt) {
  try {
    if (localStorage.getItem('kz-timer-done') === String(endAt)) return false;
    localStorage.setItem('kz-timer-done', String(endAt));
  } catch {}
  return true;
}
function readSavedTimer() {
  try {
    return JSON.parse(localStorage.getItem(TIMER_KEY));
  } catch {
    return null;
  }
}
// Applies timer state saved by this tab earlier (reload) or by another open tab.
function applySavedTimer(saved) {
  if (!saved) return;
  clearTimeout(timer.handle);
  timer.handle = null;
  timer.mode = saved.mode === 'flow' ? 'flow' : 'pomodoro';
  timer.lenMin = Math.min(60, Math.max(1, saved.lenMin || 45));
  timer.remaining = Math.min(saved.remaining ?? timer.lenMin * 60, timer.lenMin * 60);
  timer.flowAccum = saved.flowAccum || 0;
  timer.endAt = saved.endAt || null;
  timer.flowStart = saved.flowStart || null;
  timer.running = !!(timer.endAt || timer.flowStart);
  $('#kz-len-slider-val').textContent = timer.lenMin + ' min';
  $('#kz-len-slider').value = timer.lenMin;
  $('#kz-sprint-task').value = saved.task || '';
  $('#kz-sprint-task-id').dataset.restore = saved.taskId || '';
  renderSprintTaskSelect();
  if (timer.endAt) alarm.arm(timer.endAt);
  else alarm.disarm();
  if (timer.running) {
    tick();
    scheduleTick();
  }
  updateDial();
  renderTimerMode();
}

function bindTimer() {
  $('#kz-dial-progress').setAttribute('stroke-dasharray', CIRC);

  applySavedTimer(readSavedTimer());
  updateDial();
  renderTimerMode();

  $('#kz-timer-mode').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b || b.disabled || hasProgress()) return;
    timer.mode = b.dataset.mode;
    resetTimer();
  });
  $('#kz-sprint-task').addEventListener('change', persistTimer);
  $('#kz-sprint-task-id').addEventListener('change', persistTimer);
  $('#kz-len-slider').addEventListener('input', (e) => {
    if (timer.running) return;
    setLength(parseInt(e.target.value, 10));
  });
  $('#kz-timer-start').addEventListener('click', () => {
    stopAlarm();
    alarm.unlock();
    if (!timer.running && timer.mode === 'pomodoro') alarm.requestNotifications().then(renderNotifyHint);
    if (timer.running) {
      pauseTimer();
      persistTimer();
      updateDial();
    } else {
      startTimer();
    }
  });
  $('#kz-timer-reset').addEventListener('click', () => {
    stopAlarm();
    resetTimer();
  });
  $('#kz-timer-save').addEventListener('click', async () => {
    stopAlarm();
    const sec = elapsedSec();
    if (sec < 30 && !(await confirmDialog({ title: 'Bardzo krótki blok', message: 'Ten blok trwał mniej niż minutę. Zapisać go mimo to?', confirm: 'Zapisz' }))) return;
    finishBlock(Math.max(1, Math.round(sec / 60)));
  });
  $('#kz-alarm-stop').addEventListener('click', stopAlarm);
  alarm.setHandlers({ end: tick, dismiss: stopAlarm });
  renderNotifyHint();
  $('#kz-notify-hint').addEventListener('click', async (e) => {
    if (e.target.id !== 'kz-notify-enable') return;
    const state = await alarm.requestNotifications();
    renderNotifyHint();
    if (state === 'granted') toast('Powiadomienia włączone.', 'success');
  });
}

// ---------- alarm ----------
// Timing, sound and system notifications live in alarm.js; this wires them to the UI.
function startAlarm() {
  $('#kz-alarm-banner').hidden = false;
  const task = $('#kz-sprint-task').value.trim() || findTask($('#kz-sprint-task-id').value)?.text;
  alarm.ring({
    title: 'Czas minął — blok skończony',
    body: task ? `„${task}” · ${timer.lenMin} min. Zrób przerwę.` : `${timer.lenMin} min skupienia za tobą. Zrób przerwę.`,
  });
  updateTabTitle();
}
function stopAlarm() {
  alarm.silence();
  $('#kz-alarm-banner').hidden = true;
  updateTabTitle();
}

function renderNotifyHint() {
  const el = $('#kz-notify-hint');
  const state = alarm.notificationsState();
  el.hidden = timer.mode !== 'pomodoro' || state === 'granted' || state === 'unsupported';
  el.innerHTML = state === 'denied'
    ? 'Powiadomienia są zablokowane — alarm zagra, ale nie zobaczysz go poza przeglądarką. Włącz je w ustawieniach przeglądarki dla tej strony.'
    : 'Chcesz widzieć alarm także poza przeglądarką? <button type="button" class="kz-text-btn" id="kz-notify-enable">Włącz powiadomienia</button>';
}

// ---------- sprint log ----------
function logSprint(minutes) {
  const taskId = $('#kz-sprint-task-id').value || null;
  const linked = taskId && findTask(taskId);
  justLoggedSprintId = uid('sprint');
  getDay(TODAY).sprints.push({
    id: justLoggedSprintId,
    minutes,
    mode: timer.mode,
    taskId: linked ? taskId : null,
    task: $('#kz-sprint-task').value.trim() || linked?.text || '(bez opisu)',
    time: new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }),
  });
  saveLog();
  renderSprintLog();
  justLoggedSprintId = null;
  renderStreak();
  renderCalendar();
  if (linked) renderTasks(); // refresh the task's actual-time counter
}
function renderSprintLog() {
  const day = getDay(TODAY);
  const wrap = $('#kz-sprint-log');
  if (!day.sprints.length) {
    wrap.innerHTML = '<div class="kz-empty">Dziś jeszcze żadnego bloku.</div>';
    return;
  }
  const total = day.sprints.reduce((s, x) => s + x.minutes, 0);
  wrap.innerHTML =
    day.sprints.map((s) =>
      `<div class="kz-ritual-row${s.id === justLoggedSprintId ? ' kz-new' : ''}" data-id="${s.id}"><span class="mono" style="width:52px;color:var(--ink-soft);flex:none;">${s.time}</span><span style="flex:1;">${s.minutes} min — ${escapeHtml(s.task)}${s.mode === 'flow' ? ' <span class="kz-tag">flow</span>' : ''}</span><button class="kz-x" title="Usuń blok">&times;</button></div>`
    ).join('') +
    `<div class="kz-hint">Razem: ${fmtMinutes(total)}</div>`;
}
function bindSprintLog() {
  $('#kz-sprint-log').addEventListener('click', (e) => {
    const btn = e.target.closest('.kz-x');
    if (!btn) return;
    const day = getDay(TODAY);
    day.sprints = day.sprints.filter((s) => s.id !== btn.closest('.kz-ritual-row').dataset.id);
    saveLog();
    renderSprintLog();
    renderCalendar();
    renderStreak();
  });
}

// ---------- domains ----------
function renderDomainSelect() {
  const sel = $('#kz-task-domain');
  const current = sel.value;
  sel.innerHTML = config.domains.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
  if (config.domains.includes(current)) sel.value = current;
}
function renderDomainManage() {
  $('#kz-domain-manage').innerHTML = config.domains.map((d, i) => `
    <div class="kz-manage-row" data-idx="${i}">
      <input type="text" value="${escapeHtml(d)}" ${d === RECURRING_DOMAIN ? 'disabled title="Kategoria zadań powtarzalnych"' : ''}>
      ${d === RECURRING_DOMAIN ? '' : '<button class="kz-x" title="Usuń kategorię">&times;</button>'}
    </div>`).join('');
}
function bindDomains() {
  const wrap = $('#kz-domain-manage');
  wrap.addEventListener('change', (e) => {
    const idx = parseInt(e.target.closest('.kz-manage-row').dataset.idx, 10);
    const oldName = config.domains[idx];
    const newName = e.target.value.trim();
    if (!newName || (newName !== oldName && config.domains.includes(newName))) {
      e.target.value = oldName;
      return;
    }
    tasks.forEach((t) => { if (t.domain === oldName) t.domain = newName; });
    config.domains[idx] = newName;
    saveConfig();
    saveTasks();
    renderDomainSelect();
    renderTasks();
  });
  wrap.addEventListener('click', async (e) => {
    if (!e.target.closest('.kz-x')) return;
    const idx = parseInt(e.target.closest('.kz-manage-row').dataset.idx, 10);
    const name = config.domains[idx];
    const used = tasks.filter((t) => t.domain === name && !t.done).length;
    if (used && !(await confirmDialog({ title: `Usunąć kategorię „${name}”?`, message: `Ma ${used} otwartych zadań — trafią do sekcji „Inne”.`, confirm: 'Usuń', danger: true }))) return;
    config.domains.splice(idx, 1);
    saveConfig();
    renderDomainSelect();
    renderDomainManage();
    renderTasks();
  });
  const add = () => {
    const input = $('#kz-domain-new');
    const name = input.value.trim();
    if (!name || config.domains.includes(name)) return;
    config.domains.push(name);
    input.value = '';
    saveConfig();
    renderDomainSelect();
    renderDomainManage();
  };
  $('#kz-domain-add').addEventListener('click', add);
  $('#kz-domain-new').addEventListener('keydown', (e) => e.key === 'Enter' && add());
}

// ---------- tasks ----------
const PRIORITIES = {
  must: { label: 'Muszę', cls: 'pri-high', rank: 0 },
  should: { label: 'Powinienem', cls: 'pri-mid', rank: 1 },
  could: { label: 'Mogę', cls: 'pri-low', rank: 2 },
};
const PRIORITY_CYCLE = ['must', 'should', 'could'];
const priorityOf = (t) => (PRIORITIES[t.priority] ? t.priority : 'should');

// today's highlight first, then Must → Should → Could; stable within a level
function sortTasks(list) {
  const hl = getDay(TODAY).highlightId;
  return list
    .map((t, i) => [t, i])
    .sort(([a, ia], [b, ib]) =>
      (b.id === hl) - (a.id === hl) || PRIORITIES[priorityOf(a)].rank - PRIORITIES[priorityOf(b)].rank || ia - ib)
    .map(([t]) => t);
}

// minutes of logged blocks per task id, across all days
function actualMinutesByTask() {
  const map = {};
  Object.values(dailyLog).forEach((d) => d.sprints?.forEach((s) => {
    if (s.taskId) map[s.taskId] = (map[s.taskId] || 0) + s.minutes;
  }));
  return map;
}

function createTask(text, { domain, priority = 'should' } = {}) {
  const task = { id: uid('task'), text, domain: domain || defaultDomain(), priority, notes: '', done: false, createdAt: TODAY };
  tasks.push(task);
  return task;
}
function defaultDomain() {
  return config.domains.find((d) => d !== RECURRING_DOMAIN) || config.domains[0];
}

async function addTask() {
  const input = $('#kz-task-input');
  const text = input.value.trim();
  if (!text) return;
  const domain = $('#kz-task-domain').value;
  const task = { id: uid('task'), text, domain, priority: $('#kz-task-pri').value, notes: '', done: false, createdAt: TODAY };
  if (domain === RECURRING_DOMAIN) {
    if (config.recurringTasks.some((r) => r.text.trim().toLowerCase() === text.toLowerCase())) {
      toast('To zadanie już powtarza się codziennie.', 'error');
      return;
    }
    const repeat = await dialog({
      title: 'Jak często?',
      message: `„${text}” — dodać jako codzienną rutynę, czy tylko na dziś?`,
      actions: [
        { label: 'Anuluj', value: null, variant: 'ghost' },
        { label: 'Tylko dziś', value: 'once', variant: 'secondary' },
        { label: 'Codziennie', value: 'daily', variant: 'primary' },
      ],
    });
    if (!repeat) return;
    if (repeat === 'daily') {
      task.recurringId = uid('rec');
      config.recurringTasks.push({ id: task.recurringId, text, domain, notes: '' });
      saveConfig();
    }
  }
  tasks.push(task);
  input.value = '';
  saveTasks();
  justAddedId = task.id;
  renderTasks();
  justAddedId = null;
}

// ids of the most recently added task / sprint, so only those animate in
let justAddedId = null;
let justLoggedSprintId = null;

// collapses a row out, then runs `after` (usually a re-render)
function animateOut(el, after) {
  if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) return after();
  el.classList.add('kz-leaving');
  setTimeout(after, 280);
}

function renderTaskRow(t, actual) {
  const steps = countLines(t.notes);
  const linkUrl = normalizeUrl(firstUrl(t.notes));
  const isNew = t.id === justAddedId;
  const isHl = t.id === getDay(TODAY).highlightId;
  const pri = PRIORITIES[priorityOf(t)];
  const spent = actual[t.id] || 0;
  const timeValue = t.estimate ? `${spent} / ${t.estimate} min` : spent ? `${spent} min` : 'brak';
  const over = t.estimate && spent > t.estimate;
  return `<div class="kz-task-block${isNew ? ' kz-new' : ''}${isHl ? ' kz-is-hl' : ''}" data-id="${t.id}"><div class="kz-task-block-inner">
    <div class="kz-task ${t.done ? 'done' : ''}">
      <input type="checkbox" ${t.done ? 'checked' : ''} class="kz-task-check" aria-label="Ukończone">
      <input type="text" class="txt" value="${escapeHtml(t.text)}">
      ${t.recurringId ? '' : `<button class="kz-tag kz-pri ${pri.cls}" title="Priorytet — kliknij, żeby zmienić">${pri.label}</button>`}
      ${t.recurringId ? '' : `<button class="kz-star${isHl ? ' on' : ''}" title="${isHl ? 'Główne zadanie dnia' : 'Ustaw jako główne zadanie dnia'}" aria-pressed="${isHl}">${isHl ? '★' : '☆'}</button>`}
      ${linkUrl ? `<a href="${escapeHtml(linkUrl)}" target="_blank" rel="noopener" class="kz-task-link-open" title="${escapeHtml(linkUrl)}">&#8599;</a>` : ''}
      <button class="del" title="Usuń">&times;</button>
    </div>
    <div class="kz-task-panel">
      <details class="kz-task-notes-details">
        <summary>
          <span class="kz-row-icon">&#8801;</span>
          <span class="kz-row-label">Kroki</span>
          <span class="kz-row-value">${steps || 'brak'}</span>
          <span class="kz-row-chevron">&#8250;</span>
        </summary>
        <div class="kz-row-body">
          <textarea class="kz-task-notes" placeholder="Jeden krok na linię — linki też tu wklejaj">${escapeHtml(t.notes || '')}</textarea>
        </div>
      </details>
      ${t.recurringId ? '' : `<details class="kz-task-time-details">
        <summary>
          <span class="kz-row-icon">&#9719;</span>
          <span class="kz-row-label">Czas</span>
          <span class="kz-row-value${over ? ' kz-over' : ''}">${timeValue}</span>
          <span class="kz-row-chevron">&#8250;</span>
        </summary>
        <div class="kz-row-body kz-time-body">
          <label>Szacuję na <input type="number" min="1" max="1440" class="kz-task-estimate" value="${t.estimate || ''}" placeholder="—"> min</label>
          <span class="kz-hint">Faktycznie: <strong>${fmtMinutes(spent)}</strong>${spent ? '' : ' — przypisz zadanie do bloku skupienia, a czas policzy się sam.'}</span>
        </div>
      </details>`}
    </div>
  </div></div>`;
}

function updateRowLink(block, t) {
  const url = normalizeUrl(firstUrl(t.notes));
  let a = block.querySelector('.kz-task-link-open');
  if (!url) return a?.remove();
  if (!a) {
    a = Object.assign(document.createElement('a'), { className: 'kz-task-link-open', target: '_blank', rel: 'noopener', innerHTML: '&#8599;' });
    block.querySelector('.kz-task .del').before(a);
  }
  a.href = url;
  a.title = url;
}

function renderTasks() {
  const wrap = $('#kz-task-list');
  // finished recurring copies stay in the data (calendar, streak) but leave the list
  const visible = sortTasks(tasks.filter((t) => !(t.recurringId && t.done)));
  const actual = actualMinutesByTask();
  let html = '';
  const section = (name, list, important) => {
    html += `<div class="kz-domain-head${important ? ' kz-domain-important' : ''}"><span class="kz-domain-text">${escapeHtml(name)}</span></div>`;
    list.forEach((t) => (html += renderTaskRow(t, actual)));
  };
  config.domains.forEach((dom) => {
    const list = visible.filter((t) => t.domain === dom);
    if (list.length) section(dom, list, dom.trim().toLowerCase() === 'ważne');
  });
  const orphans = visible.filter((t) => !config.domains.includes(t.domain));
  if (orphans.length) section('Inne', orphans, false);
  wrap.innerHTML = html || `<div class="kz-empty">${tasks.length ? 'Brak zadań na teraz — dodaj nowe wyżej.' : 'Brak zadań — dodaj pierwsze wyżej.'}</div>`;
  renderHighlight();
  renderSprintTaskSelect();
}

function setHighlight(id) {
  getDay(TODAY).highlightId = id || null;
  saveLog();
  renderTasks();
  renderRitualProgress();
}

function bindTasks() {
  $('#kz-task-add').addEventListener('click', addTask);
  $('#kz-task-input').addEventListener('keydown', (e) => e.key === 'Enter' && addTask());

  const wrap = $('#kz-task-list');
  const taskOf = (el) => findTask(el.closest('.kz-task-block').dataset.id);
  const templateOf = (t) => t.recurringId && config.recurringTasks.find((r) => r.id === t.recurringId);

  wrap.addEventListener('change', (e) => {
    const el = e.target;
    const t = taskOf(el);
    if (!t) return;
    if (el.classList.contains('kz-task-check')) {
      t.done = el.checked;
      t.completedAt = t.done ? TODAY : null;
      saveTasks();
      renderStreak();
      renderCalendar();
      if (t.id === getDay(TODAY).highlightId) {
        renderHighlight();
        renderRitualProgress();
        if (t.done) toast('Główne zadanie dnia zrobione. Dobry dzień!', 'success');
      }
      // finished routines leave the list; regular tasks just restyle in place
      if (t.recurringId && t.done) animateOut(el.closest('.kz-task-block'), renderTasks);
      else {
        el.closest('.kz-task').classList.toggle('done', t.done);
        renderSprintTaskSelect();
      }
    } else if (el.classList.contains('txt')) {
      t.text = el.value;
      // keeps the recurring template in sync for future days
      const rt = templateOf(t);
      if (rt) { rt.text = el.value; saveConfig(); }
      saveTasks();
      renderHighlight();
      renderSprintTaskSelect();
    } else if (el.classList.contains('kz-task-estimate')) {
      const v = parseInt(el.value, 10);
      t.estimate = v > 0 ? v : null;
      saveTasks();
      renderTasks();
      // keep the panel open after the re-render
      $(`.kz-task-block[data-id="${t.id}"] .kz-task-time-details`)?.setAttribute('open', '');
    } else if (el.classList.contains('kz-task-notes')) {
      t.notes = el.value;
      const rt = templateOf(t);
      if (rt) { rt.notes = el.value; saveConfig(); }
      saveTasks();
      el.closest('details').querySelector('.kz-row-value').textContent = countLines(el.value) || 'brak';
      updateRowLink(el.closest('.kz-task-block'), t);
    }
  });

  wrap.addEventListener('click', async (e) => {
    const priBtn = e.target.closest('.kz-pri');
    if (priBtn) {
      const t = taskOf(priBtn);
      t.priority = PRIORITY_CYCLE[(PRIORITY_CYCLE.indexOf(priorityOf(t)) + 1) % PRIORITY_CYCLE.length];
      saveTasks();
      const p = PRIORITIES[t.priority];
      priBtn.className = `kz-tag kz-pri ${p.cls} kz-bump`;
      priBtn.textContent = p.label;
      return;
    }
    const star = e.target.closest('.kz-star');
    if (star) {
      const t = taskOf(star);
      setHighlight(getDay(TODAY).highlightId === t.id ? null : t.id);
      return;
    }
    const btn = e.target.closest('.del');
    if (!btn) return;
    const t = taskOf(btn);
    if (!t) return;
    if (t.recurringId) {
      const choice = await dialog({
        title: 'Usunąć rutynę?',
        message: `„${t.text}” powtarza się codziennie.`,
        actions: [
          { label: 'Anuluj', value: null, variant: 'ghost' },
          { label: 'Tylko dziś', value: 'today', variant: 'secondary' },
          { label: 'Na zawsze', value: 'forever', variant: 'danger' },
        ],
      });
      if (!choice) return;
      if (choice === 'forever') {
        config.recurringTasks = config.recurringTasks.filter((r) => r.id !== t.recurringId);
        saveConfig();
      }
    }
    tasks = tasks.filter((x) => x.id !== t.id);
    saveTasks();
    if (getDay(TODAY).highlightId === t.id) { getDay(TODAY).highlightId = null; saveLog(); }
    renderStreak();
    renderCalendar();
    animateOut(btn.closest('.kz-task-block'), renderTasks);
  });

  // notes textarea: bullet list editing
  wrap.addEventListener('focusin', (e) => {
    const ta = e.target;
    if (!ta.classList.contains('kz-task-notes') || ta.value) return;
    ta.value = '- ';
    autosize(ta);
    ta.setSelectionRange(2, 2);
  });
  wrap.addEventListener('keydown', (e) => {
    const ta = e.target;
    if (!ta.classList.contains('kz-task-notes') || e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    const { selectionStart: start, selectionEnd: end } = ta;
    ta.value = ta.value.slice(0, start) + '\n- ' + ta.value.slice(end);
    ta.setSelectionRange(start + 3, start + 3);
    autosize(ta);
  });
  // steps: live counter + link shortcut while typing, saved shortly after typing stops
  let notesSaveTimer = null;
  wrap.addEventListener('input', (e) => {
    const ta = e.target;
    if (!ta.classList.contains('kz-task-notes')) return;
    autosize(ta);
    const t = taskOf(ta);
    if (!t) return;
    ta.closest('details').querySelector('.kz-row-value').textContent = countLines(ta.value) || 'brak';
    t.notes = ta.value;
    updateRowLink(ta.closest('.kz-task-block'), t);
    clearTimeout(notesSaveTimer);
    notesSaveTimer = setTimeout(() => {
      const rt = templateOf(t);
      if (rt) { rt.notes = t.notes; saveConfig(); }
      saveTasks();
    }, 600);
  });
  // 'toggle' doesn't bubble, so listen in the capture phase
  wrap.addEventListener('toggle', (e) => {
    if (e.target.open && e.target.classList.contains('kz-task-notes-details')) autosize($('.kz-task-notes', e.target));
  }, true);
}

// ---------- start dnia: highlight · micro-commitment ----------
function renderRitual() {
  renderHighlight();
  renderMicro();
  renderRitualProgress();
}

function renderHighlight() {
  const wrap = $('#kz-highlight');
  if (wrap.contains(document.activeElement) && document.activeElement.id === 'kz-hl-input') return;
  const t = findTask(getDay(TODAY).highlightId);
  if (t) {
    wrap.innerHTML = `<div class="kz-hl-set${t.done ? ' done' : ''}">
      <input type="checkbox" class="kz-hl-check" ${t.done ? 'checked' : ''} aria-label="Zrobione">
      <span class="kz-hl-text">${escapeHtml(t.text)}</span>
      <button type="button" class="kz-text-btn" id="kz-hl-clear">zmień</button>
    </div>`;
  } else {
    wrap.innerHTML = `<div class="kz-hl-pick">
      <input type="text" id="kz-hl-input" placeholder="Co sprawi, że dziś będzie dobry dzień?">
      <button type="button" class="kz-btn small" id="kz-hl-set">Ustaw</button>
    </div>
    <div class="kz-hint">…albo kliknij ☆ przy zadaniu na liście.</div>`;
  }
}

function microStreak() {
  const cursor = new Date();
  if (!dailyLog[todayKey(cursor)]?.micro?.done) cursor.setDate(cursor.getDate() - 1);
  let n = 0;
  while (dailyLog[todayKey(cursor)]?.micro?.done) { n++; cursor.setDate(cursor.getDate() - 1); }
  return n;
}
function renderMicro() {
  const day = getDay(TODAY);
  const text = $('#kz-micro-text');
  if (document.activeElement !== text) text.value = config.micro || '';
  $('#kz-micro-done').checked = !!day.micro?.done;
  $('#kz-micro').classList.toggle('done', !!day.micro?.done);
  const n = microStreak();
  $('#kz-micro-streak').textContent = n ? `seria: ${n}` : '';
}

function renderRitualProgress() {
  const day = getDay(TODAY);
  const hl = findTask(day.highlightId);
  const steps = [!!hl?.done, !!day.micro?.done];
  const done = steps.filter(Boolean).length;
  $('#kz-ritual-progress').innerHTML = steps.map((s) => `<span class="kz-dot${s ? ' on' : ''}"></span>`).join('') + ` ${done}/${steps.length}`;
}

function bindRitual() {
  const hl = $('#kz-highlight');
  const setFromInput = () => {
    const input = $('#kz-hl-input');
    const text = input?.value.trim();
    if (!text) return;
    const existing = tasks.find((x) => !x.done && x.text.trim().toLowerCase() === text.toLowerCase());
    const task = existing || createTask(text, { priority: 'must', domain: config.domains.includes('Ważne') ? 'Ważne' : defaultDomain() });
    if (!existing) saveTasks();
    input.blur();
    setHighlight(task.id);
  };
  hl.addEventListener('click', (e) => {
    if (e.target.id === 'kz-hl-set') setFromInput();
    if (e.target.id === 'kz-hl-clear') {
      setHighlight(null);
      $('#kz-hl-input')?.focus();
    }
  });
  hl.addEventListener('keydown', (e) => {
    if (e.target.id === 'kz-hl-input' && e.key === 'Enter') setFromInput();
  });
  hl.addEventListener('change', (e) => {
    if (!e.target.classList.contains('kz-hl-check')) return;
    const task = findTask(getDay(TODAY).highlightId);
    if (!task) return;
    task.done = e.target.checked;
    task.completedAt = task.done ? TODAY : null;
    saveTasks();
    renderTasks();
    renderStreak();
    renderCalendar();
    renderRitualProgress();
    if (task.done) toast('Główne zadanie dnia zrobione. Dobry dzień!', 'success');
  });

  $('#kz-micro-text').addEventListener('change', (e) => {
    config.micro = e.target.value.trim();
    saveConfig();
  });
  $('#kz-micro-done').addEventListener('change', (e) => {
    const day = getDay(TODAY);
    if (e.target.checked && !config.micro) {
      e.target.checked = false;
      toast('Najpierw wpisz swój mikro-nawyk.', 'error');
      $('#kz-micro-text').focus();
      return;
    }
    day.micro = { text: config.micro, done: e.target.checked };
    saveLog();
    renderMicro();
    renderRitualProgress();
    renderCalendar();
    if (e.target.checked) {
      const n = microStreak();
      toast(n > 1 ? `Mikro-nawyk: seria ${n} dni z rzędu!` : 'Mikro-nawyk odhaczony.', 'success');
    }
  });
}

// ---------- weekly review ----------
const WEEKDAYS = ['Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So', 'Nd'];
function mondayOf(d) {
  const m = new Date(d);
  m.setHours(0, 0, 0, 0);
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
  return m;
}
let weekStart = mondayOf(new Date());

function pct(part, total) {
  return total ? Math.round((part / total) * 100) : 0;
}

function weekStats(start) {
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return todayKey(d);
  });
  const daySet = new Set(days);
  const elapsed = days.filter((k) => k <= TODAY).length;
  const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));

  const perDay = days.map((key, i) => {
    const log = dailyLog[key] || {};
    const hl = log.highlightId && byId[log.highlightId];
    return {
      key, name: WEEKDAYS[i], future: key > TODAY, today: key === TODAY,
      minutes: (log.sprints || []).reduce((s, x) => s + x.minutes, 0),
      hl: hl ? (hl.done ? 'done' : 'set') : 'none',
      micro: !!log.micro?.done,
    };
  });

  const time = { must: 0, should: 0, could: 0, none: 0 };
  days.forEach((key) => (dailyLog[key]?.sprints || []).forEach((s) => {
    const t = s.taskId && byId[s.taskId];
    time[t ? priorityOf(t) : 'none'] += s.minutes;
  }));
  const totalMin = Object.values(time).reduce((a, b) => a + b, 0);

  const doneTasks = tasks.filter((t) => t.done && daySet.has(t.completedAt));
  const done = { must: 0, should: 0, could: 0, routine: 0 };
  doneTasks.forEach((t) => (t.recurringId ? done.routine++ : done[priorityOf(t)]++));

  const actual = actualMinutesByTask();
  const estimated = doneTasks.filter((t) => t.estimate && actual[t.id]);
  const estSum = estimated.reduce((s, t) => s + t.estimate, 0);
  const actSum = estimated.reduce((s, t) => s + actual[t.id], 0);

  const doneDays = new Set(doneTasks.map((t) => t.completedAt));
  // days the app was actually used — critical nudges wait until there's enough data
  const activeDays = perDay.filter((d) => d.minutes || d.hl !== 'none' || d.micro || doneDays.has(d.key)).length;

  return {
    days, perDay, elapsed, activeDays, time, totalMin, done, doneCount: doneTasks.length,
    hlDone: perDay.filter((d) => d.hl === 'done').length,
    microDone: perDay.filter((d) => d.micro).length,
    estimateRatio: estimated.length >= 2 && estSum ? actSum / estSum : null,
    estimatedCount: estimated.length,
  };
}

function weekNudges(s) {
  const out = [];
  const tracked = s.totalMin - s.time.none;
  if (s.elapsed >= 3 && s.hlDone >= Math.max(3, s.elapsed - 1)) out.push(['good', `Świetnie — ${s.hlDone}/${s.elapsed} głównych zadań dnia zrobionych.`]);
  else if (s.activeDays >= 3 && s.hlDone <= 1) out.push(['warn', `Tylko ${s.hlDone} ${s.hlDone === 1 ? 'główne zadanie' : 'głównych zadań'} w tym tygodniu. Wybieraj jedno rano — to wystarczy.`]);
  if (tracked >= 60 && pct(s.time.must, tracked) >= 70) out.push(['warn', `${pct(s.time.must, tracked)}% czasu poszło na rzeczy z „Muszę”. Zarezerwuj blok na „Powinienem” — tam zwykle są długoterminowe cele.`]);
  if (tracked >= 60 && pct(s.time.could, tracked) >= 45) out.push(['warn', `${pct(s.time.could, tracked)}% czasu na „Mogę”. Czy to nie ucieczka od trudniejszych zadań?`]);
  if (s.estimateRatio && s.estimateRatio >= 1.3) out.push(['warn', `Zadania trwają średnio ${s.estimateRatio.toFixed(1).replace('.', ',')}× dłużej, niż zakładasz. Planuj z zapasem.`]);
  if (s.estimateRatio && s.estimateRatio <= 0.75) out.push(['good', 'Idzie ci szybciej, niż szacujesz — możesz planować odważniej.']);
  if (s.elapsed >= 4 && s.microDone >= s.elapsed - 1 && s.microDone >= 4) out.push(['good', `Mikro-nawyk: ${s.microDone}/${s.elapsed} dni. Nawyk się zakorzenia.`]);
  else if (s.activeDays >= 4 && s.microDone <= 1) out.push(['warn', 'Mikro-nawyk prawie nie istnieje. Może jest za duży? Zmniejsz go do 2 minut.']);
  if (s.activeDays >= 3 && s.totalMin === 0) out.push(['warn', 'Brak zapisanych bloków skupienia. Spróbuj jutro jednego — nawet 15 minut w trybie Flow.']);
  if (s.time.none >= 60 && pct(s.time.none, s.totalMin) >= 50) out.push(['info', 'Większość bloków nie ma przypisanego zadania — przypisuj je, a zobaczysz, dokąd idzie twój czas.']);
  if (!out.length) out.push(['info', s.elapsed ? 'Każdy mały krok się liczy. Tak trzymaj.' : 'Ten tydzień jeszcze się nie zaczął.']);
  return out;
}

function renderWeek() {
  if ($('#kz-week-view').hidden) return;
  const s = weekStats(weekStart);
  const end = new Date(weekStart);
  end.setDate(end.getDate() + 6);
  const fmtD = (d) => d.toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' });
  const isCurrent = s.days.includes(TODAY);
  $('#kz-week-label').textContent = `${fmtD(weekStart)} – ${fmtD(end)}${isCurrent ? ' · ten tydzień' : ''}`;
  $('#kz-week-next').disabled = isCurrent;

  const maxMin = Math.max(60, ...s.perDay.map((d) => d.minutes));
  const denom = s.elapsed || 7;
  const tracked = s.totalMin;
  const bar = (label, min, cls) => `<div class="kz-bar-row"><span class="kz-bar-label">${label}</span><div class="kz-bar-track"><div class="kz-bar-fill ${cls}" style="--w:${pct(min, tracked)}%"></div></div><span class="kz-bar-pct">${pct(min, tracked)}%</span></div>`;

  $('#kz-week').innerHTML = `
    <div class="kz-week-days">
      ${s.perDay.map((d) => `
        <div class="kz-wd${d.future ? ' future' : ''}${d.today ? ' today' : ''}" title="${d.minutes} min skupienia">
          <span class="kz-wd-min mono">${d.minutes ? d.minutes : ''}</span>
          <div class="kz-wd-bar"><span style="--h:${pct(d.minutes, maxMin)}%"></span></div>
          <span class="kz-wd-dot hl ${d.hl}" title="Główne zadanie"></span>
          <span class="kz-wd-dot mc${d.micro ? ' done' : ''}" title="Mikro-nawyk"></span>
          <span class="kz-wd-name mono">${d.name}</span>
        </div>`).join('')}
    </div>
    <div class="kz-week-legend mono"><span><i class="kz-wd-dot hl done"></i>główne zadanie</span><span><i class="kz-wd-dot mc done"></i>mikro-nawyk</span><span><i class="kz-legend-bar"></i>minuty skupienia</span></div>

    <div class="kz-tiles">
      <div class="kz-tile"><span class="kz-tile-val">${s.hlDone}<small>/${denom}</small></span><span class="kz-tile-lbl">Główne zadania</span></div>
      <div class="kz-tile"><span class="kz-tile-val">${s.microDone}<small>/${denom}</small></span><span class="kz-tile-lbl">Mikro-nawyk</span></div>
      <div class="kz-tile"><span class="kz-tile-val">${fmtMinutes(s.totalMin).replace(' min', '<small> min</small>').replace(' h', '<small> h</small>')}</span><span class="kz-tile-lbl">Skupienie</span></div>
      <div class="kz-tile"><span class="kz-tile-val">${s.doneCount}</span><span class="kz-tile-lbl">Ukończone</span></div>
    </div>

    <h3 class="kz-week-h">Dokąd poszedł czas</h3>
    ${tracked ? `<div class="kz-bars">
      ${bar('Muszę', s.time.must, 'pri-high')}
      ${bar('Powinienem', s.time.should, 'pri-mid')}
      ${bar('Mogę', s.time.could, 'pri-low')}
      ${s.time.none ? bar('Bez zadania', s.time.none, 'none') : ''}
    </div>` : '<div class="kz-empty">Brak zapisanych bloków w tym tygodniu.</div>'}

    <h3 class="kz-week-h">Ukończone zadania</h3>
    <div class="kz-week-done mono">
      <span class="kz-tag pri-high">Muszę · ${s.done.must}</span>
      <span class="kz-tag pri-mid">Powinienem · ${s.done.should}</span>
      <span class="kz-tag pri-low">Mogę · ${s.done.could}</span>
      <span class="kz-tag">Rutyny · ${s.done.routine}</span>
    </div>
    ${s.estimateRatio ? `<p class="kz-hint">Szacunki (${s.estimatedCount} zadań): realnie zajęły ${Math.round(s.estimateRatio * 100)}% planowanego czasu.</p>` : ''}

    <h3 class="kz-week-h">Wnioski</h3>
    <ul class="kz-nudges">${weekNudges(s).map(([type, text]) => `<li class="${type}">${escapeHtml(text)}</li>`).join('')}</ul>`;

  const note = $('#kz-week-reflection');
  if (document.activeElement !== note) note.value = config.weekNotes[todayKey(weekStart)] || '';
  $('#kz-week-saved').textContent = '';
}

function bindWeek() {
  $('#kz-week-prev').addEventListener('click', () => withTransition(() => { weekStart.setDate(weekStart.getDate() - 7); renderWeek(); }, 'prev'));
  $('#kz-week-next').addEventListener('click', () => withTransition(() => { weekStart.setDate(weekStart.getDate() + 7); renderWeek(); }, 'next'));
  let t;
  $('#kz-week-reflection').addEventListener('input', (e) => {
    const key = todayKey(weekStart);
    if (e.target.value.trim()) config.weekNotes[key] = e.target.value;
    else delete config.weekNotes[key];
    $('#kz-week-saved').textContent = 'zapisywanie...';
    clearTimeout(t);
    t = setTimeout(() => { saveConfig(); $('#kz-week-saved').textContent = 'zapisano'; }, 600);
  });
}

// ---------- simple / advanced mode ----------
function applyMode() {
  const simple = config.mode === 'simple';
  document.body.classList.toggle('kz-simple', simple);
  const seg = $('#kz-mode');
  seg.dataset.active = simple ? 'simple' : 'advanced';
  seg.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === seg.dataset.active)));
}
function bindMode() {
  $('#kz-mode').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b || b.dataset.mode === config.mode) return;
    config.mode = b.dataset.mode;
    saveConfig();
    // cards keep their identity (view-transition-name), so they glide to new spots
    withTransition(applyMode, 'mode');
    toast(config.mode === 'simple' ? 'Tryb prosty — zadania, blok skupienia i opis dnia.' : 'Tryb pełny — wszystkie funkcje.', 'info', 2200);
  });
}

// ---------- calendar ----------
const MONTH_NAMES = ['Styczeń', 'Luty', 'Marzec', 'Kwiecień', 'Maj', 'Czerwiec', 'Lipiec', 'Sierpień', 'Wrzesień', 'Październik', 'Listopad', 'Grudzień'];
const calCursor = new Date();
calCursor.setDate(1);
let calSelected = TODAY;

function renderCalendar() {
  if ($('#kz-calendar-view').hidden) return; // rendered on demand when the view opens
  const year = calCursor.getFullYear();
  const month = calCursor.getMonth();
  $('#kz-cal-month-label').textContent = `${MONTH_NAMES[month]} ${year}`;

  const doneByDay = {};
  tasks.forEach((t) => t.done && t.completedAt && (doneByDay[t.completedAt] = (doneByDay[t.completedAt] || 0) + 1));

  const startOffset = (new Date(year, month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  let html = '<div class="kz-cal-day empty"></div>'.repeat(startOffset);
  for (let d = 1; d <= daysInMonth; d++) {
    const key = todayKey(new Date(year, month, d));
    const hasLog = !!dailyLog[key]?.sprints?.length;
    const done = doneByDay[key] || 0;
    const cls = 'kz-cal-day' + (key === TODAY ? ' today' : '') + (key === calSelected ? ' selected' : '');
    html += `<button class="${cls}" data-date="${key}">${d}${done ? `<span class="kz-cal-count mono">${done}</span>` : ''}${hasLog ? '<span class="kz-cal-dot"></span>' : ''}</button>`;
  }
  $('#kz-cal-grid').innerHTML = html;
  renderCalDetail();
}

function renderCalDetail() {
  const day = dailyLog[calSelected];
  const done = tasks.filter((t) => t.done && t.completedAt === calSelected);
  const pending = tasks.filter((t) => !t.done && t.createdAt === calSelected);
  const label = new Date(calSelected + 'T00:00:00').toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long' });
  const field = (lbl, val) => `<div class="kz-cal-detail-row"><span class="lbl">${lbl}</span><span class="val">${val}</span></div>`;

  let body = '';
  if (done.length) body += field('Ukończone zadania', done.map((t) => `<span style="text-decoration:line-through;color:var(--ink-soft);">${escapeHtml(t.text)}</span>`).join('<br>'));
  const hl = day?.highlightId && findTask(day.highlightId);
  if (hl) body += field('Główne zadanie dnia', `${hl.done ? '★' : '☆'} ${escapeHtml(hl.text)}${hl.done ? '' : ' <span style="color:var(--ink-soft);">(niezrobione)</span>'}`);
  if (day?.micro?.text) body += field('Mikro-nawyk', `${day.micro.done ? '✓' : '—'} ${escapeHtml(day.micro.text)}`);
  if (pending.length) body += field('Nieukończone zadania', pending.map((t) => escapeHtml(t.text)).join('<br>'));
  if (day?.sprints?.length) {
    const total = day.sprints.reduce((s, x) => s + x.minutes, 0);
    body += field(`Bloki skupienia · ${fmtMinutes(total)}`, day.sprints.map((s) => `${s.minutes} min — ${escapeHtml(s.task)}${s.mode === 'flow' ? ' · flow' : ''}`).join('<br>'));
  }
  if (day?.note?.trim()) body += field('Opis dnia', escapeHtml(day.note).replace(/\n/g, '<br>'));
  $('#kz-cal-detail').innerHTML = `<div class="kz-cal-detail"><h3>${label}</h3>${body || '<div class="kz-empty">Brak wpisów tego dnia.</div>'}</div>`;
}

function bindCalendar() {
  $('#kz-cal-prev').addEventListener('click', () => withTransition(() => { calCursor.setMonth(calCursor.getMonth() - 1); renderCalendar(); }, 'prev'));
  $('#kz-cal-next').addEventListener('click', () => withTransition(() => { calCursor.setMonth(calCursor.getMonth() + 1); renderCalendar(); }, 'next'));
  $('#kz-cal-grid').addEventListener('click', (e) => {
    const cell = e.target.closest('[data-date]');
    if (!cell) return;
    calSelected = cell.dataset.date;
    renderCalendar();
  });
}

// ---------- export / import ----------
function bindBackup() {
  $('#kz-export').addEventListener('click', () => {
    const data = { version: 1, exportedAt: new Date().toISOString(), 'daily-log': dailyLog, tasks, config };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `kaizen-${TODAY}.json` });
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $('#kz-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.tasks) || typeof data['daily-log'] !== 'object') throw new Error('format');
      if (!(await confirmDialog({ title: 'Zastąpić dane?', message: 'Import nadpisze obecne zadania, dziennik i ustawienia.', confirm: 'Importuj', danger: true }))) return;
      store.set('daily-log', data['daily-log']);
      store.set('tasks', data.tasks);
      store.set('config', data.config || {});
      loadState();
      renderAll();
      toast('Dane zaimportowane.', 'success');
    } catch {
      toast('Nie udało się wczytać pliku — to nie wygląda na eksport z Kaizen.', 'error', 5000);
    }
  });
}

// ---------- sync status ----------
const SYNC_LABELS = { pending: 'zmiany…', saving: 'zapisywanie…', synced: 'zsynchronizowano', error: 'błąd synchronizacji', offline: 'offline' };
// Normally just a coloured dot (label in the tooltip) so the header never reflows
// while saving; only problems get spelled out.
function setSyncStatus(s, detail = '') {
  const el = $('#kz-sync');
  const problem = s === 'error' || s === 'offline';
  const label = (SYNC_LABELS[s] || s) + (problem ? ' — kliknij, żeby ponowić' : '') + (detail ? `\n${detail}` : '');
  el.hidden = false;
  el.dataset.state = s;
  el.title = label;
  el.setAttribute('aria-label', label);
  el.textContent = problem ? SYNC_LABELS[s] : '';
}

// ---------- auth & boot ----------
let started = false;

function startApp() {
  if (started) return;
  started = true;
  hideAuth();
  loadState();
  renderAll();
  bindTitles();
  bindDayNote();
  bindTimer();
  bindSprintLog();
  bindDomains();
  bindTasks();
  bindCalendar();
  bindBackup();
  bindRitual();
  bindWeek();
  bindMode();
  bindCrossTab();
  applyRoute();

  window.addEventListener('hashchange', () => withTransition(applyRoute, 'route'));
  // entrance animations only for the first paint; later changes use view transitions
  setTimeout(() => document.documentElement.classList.add('kz-booted'), 900);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    tick();
    checkDayRollover();
    refreshFromRemote();
  });
  setInterval(checkDayRollover, 60 * 1000);
}

// pulls changes made on other devices, unless the user is mid-edit here
async function refreshFromRemote() {
  if (!started || store.hasPendingWrites()) return;
  const active = document.activeElement;
  if (active && active.matches('input[type=text], textarea, [contenteditable]')) return;
  if (await store.pull()) {
    loadState();
    renderAll();
  }
}

// ---------- session & background sync ----------
function hasStoredSession() {
  try {
    return Object.keys(localStorage).some((k) => /^sb-.+-auth-token$/.test(k));
  } catch {
    return false;
  }
}
function showSignedIn(email) {
  $('#kz-account').textContent = email || '';
  $('#kz-signout').hidden = false;
  $('#kz-setpass').hidden = false;
}
// re-reads state after remote data landed in the local cache
function applyStoredState() {
  loadState();
  renderAll();
}
async function syncInBackground(uid, email) {
  try {
    if (await store.connect(uid, email)) applyStoredState();
  } catch (err) {
    console.error('initial sync failed', err);
  }
}
async function verifySessionInBackground(expectedUid) {
  let session;
  try {
    ({ data: { session } } = await withTimeout(supabase.auth.getSession(), 15000));
  } catch (err) {
    console.error('session check failed', err);
    setSyncStatus('offline', 'Brak połączenia z serwerem — zmiany zapiszą się, gdy wróci.');
    return;
  }
  if (!session) {
    toast('Sesja wygasła — zaloguj się ponownie. Twoje zmiany czekają na wysłanie.', 'error', 6000);
    showAuth('login');
    return;
  }
  if (session.user.id !== expectedUid) return location.reload();
  showSignedIn(session.user.email);
  syncInBackground(session.user.id, session.user.email);
}

// Several open tabs share localStorage: when another tab saves, pick up its data
// here so this tab doesn't later overwrite it with a stale copy.
function bindCrossTab() {
  let pending = null;
  window.addEventListener('storage', (e) => {
    if (e.key === TIMER_KEY) return applySavedTimer(readSavedTimer());
    if (!e.key || !['kz:daily-log', 'kz:tasks', 'kz:config'].includes(e.key)) return;
    clearTimeout(pending);
    pending = setTimeout(function apply() {
      const active = document.activeElement;
      // don't yank the list out from under someone typing; retry shortly
      if (active && active.matches('input[type=text], input[type=number], textarea, [contenteditable]')) {
        pending = setTimeout(apply, 1500);
        return;
      }
      applyStoredState();
    }, 150);
  });
}

// ---------- auth screen ----------
const AUTH_MODES = {
  login:    { tabs: true,  fields: ['email', 'password'], submit: 'Zaloguj się' },
  register: { tabs: true,  fields: ['email', 'password', 'password2'], submit: 'Załóż konto' },
  reset:    { tabs: false, fields: ['email'], submit: 'Wyślij link do zmiany hasła',
              title: 'Reset hasła', hint: 'Wyślemy Ci maila z linkiem do ustawienia nowego hasła.' },
  magic:    { tabs: false, fields: ['email'], submit: 'Wyślij link logowania',
              title: 'Logowanie linkiem', hint: 'Bez hasła — klikasz link z maila i jesteś zalogowany.' },
  newpass:  { tabs: false, fields: ['password', 'password2'], submit: 'Zapisz hasło',
              title: 'Ustaw hasło', hint: 'Od teraz zalogujesz się e-mailem i tym hasłem.' },
};
const AUTH_ERRORS = {
  'Invalid login credentials': 'Nieprawidłowy e-mail lub hasło.',
  'Email not confirmed': 'Najpierw potwierdź adres e-mail — kliknij link z maila rejestracyjnego.',
  'User already registered': 'Konto z tym adresem już istnieje — zaloguj się.',
  'New password should be different from the old password.': 'Nowe hasło musi różnić się od obecnego.',
};
function authErrorText(error) {
  if (error.status === 429 || /rate limit/i.test(error.message)) return 'Za dużo prób — odczekaj chwilę i spróbuj ponownie.';
  if (/password should be at least/i.test(error.message)) return 'Hasło musi mieć co najmniej 6 znaków.';
  if (/fetch|network|load failed/i.test(error.message)) return 'Brak połączenia z serwerem. Sprawdź internet.';
  return AUTH_ERRORS[error.message] || error.message;
}

let authMode = 'login';

// Supabase calls have no timeout of their own; a stalled request (flaky network,
// content blocker, stale stored session) would otherwise leave "Chwileczkę..." forever.
const AUTH_TIMEOUT_MS = 12000;
function withTimeout(promise, ms = AUTH_TIMEOUT_MS) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => { t = setTimeout(() => reject(Object.assign(new Error('timeout'), { timeout: true })), ms); }),
  ]).finally(() => clearTimeout(t));
}
// removes Supabase's stored session (sb-*-auth-token) so the next attempt starts clean
function clearStoredAuth() {
  try {
    Object.keys(localStorage).filter((k) => k.startsWith('sb-')).forEach((k) => localStorage.removeItem(k));
  } catch {}
}

function setAuthMode(mode) {
  authMode = mode;
  const cfg = AUTH_MODES[mode];
  $('#kz-auth-tabs').hidden = !cfg.tabs;
  if (cfg.tabs) $('#kz-auth-tabs').dataset.active = mode;
  $('#kz-auth-tabs').querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
  $('#kz-auth-heading').hidden = cfg.tabs;
  if (!cfg.tabs) {
    $('#kz-auth-heading-text').textContent = cfg.title;
    $('#kz-auth-heading-hint').textContent = cfg.hint;
    $('#kz-auth-heading [data-mode]').innerHTML = mode === 'newpass' && started ? '&larr; Wróć do aplikacji' : '&larr; Wróć do logowania';
  }
  document.querySelectorAll('#kz-auth-form [data-field]').forEach((el) => (el.hidden = !cfg.fields.includes(el.dataset.field)));
  $('#kz-auth-password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#kz-auth-submit').textContent = cfg.submit;
  $('#kz-auth-links').hidden = mode !== 'login';
  $('#kz-auth-local-wrap').hidden = $('#kz-login-local').hidden = mode === 'newpass';
  authMessage('');
}

function authMessage(text, isError = false) {
  const el = $('#kz-auth-msg');
  el.className = 'kz-msg' + (isError ? ' err' : '');
  el.textContent = text;
}

function showAuth(mode = 'login') {
  document.body.classList.add('kz-auth-mode');
  $('#kz-login-view').hidden = false;
  $('#kz-app').hidden = true;
  setAuthMode(mode);
  const first = mode === 'newpass' ? '#kz-auth-password' : '#kz-auth-email';
  if (matchMedia('(min-width: 821px)').matches) $(first).focus();
}

function hideAuth() {
  document.body.classList.remove('kz-auth-mode');
  $('#kz-login-view').hidden = true;
  $('#kz-app').hidden = false;
}

async function submitAuth(e) {
  e.preventDefault();
  const email = $('#kz-auth-email').value.trim();
  const password = $('#kz-auth-password').value;
  const password2 = $('#kz-auth-password2').value;
  const fields = AUTH_MODES[authMode].fields;

  if (fields.includes('email') && !/^\S+@\S+\.\S+$/.test(email)) return authMessage('Podaj poprawny adres e-mail.', true);
  if (fields.includes('password') && password.length < 6) return authMessage('Hasło musi mieć co najmniej 6 znaków.', true);
  if (fields.includes('password2') && password !== password2) return authMessage('Hasła nie są takie same.', true);

  const btn = $('#kz-auth-submit');
  btn.disabled = true;
  authMessage('Chwileczkę...');
  const redirect = { emailRedirectTo: location.origin };
  let result;
  try {
    result = await withTimeout(runAuthAction(email, password, redirect));
  } catch (err) {
    result = { error: err };
  }
  btn.disabled = false;
  if (result.error?.timeout) {
    console.error('auth request timed out', authMode);
    clearStoredAuth();
    return authMessage('Serwer nie odpowiedział. Wyczyściłem zapisaną sesję — odśwież stronę (⌘R) i spróbuj jeszcze raz. Jeśli to się powtarza, wyłącz bloker treści dla tej strony.', true);
  }
  if (result.error) {
    console.error('auth error', result.error);
    return authMessage(authErrorText(result.error), true);
  }
  handleAuthSuccess(result);
}

function runAuthAction(email, password, redirect) {
  if (authMode === 'login') return supabase.auth.signInWithPassword({ email, password });
  if (authMode === 'register') return supabase.auth.signUp({ email, password, options: redirect });
  if (authMode === 'reset') return supabase.auth.resetPasswordForEmail(email, { redirectTo: location.origin });
  if (authMode === 'magic') return supabase.auth.signInWithOtp({ email, options: redirect });
  return supabase.auth.updateUser({ password });
}

function handleAuthSuccess(result) {
  if (authMode === 'login') {
    authMessage('Zalogowano.');
    location.reload();
  } else if (authMode === 'register') {
    if (result.data.session) return location.reload(); // email confirmation turned off
    // Supabase hides whether the address exists; an empty identities list means it does
    if (result.data.user && result.data.user.identities?.length === 0) {
      authMessage('Konto z tym adresem już istnieje — zaloguj się lub zresetuj hasło.', true);
    } else {
      authMessage('Gotowe! Wysłaliśmy maila z linkiem potwierdzającym — kliknij go, a potem zaloguj się.');
    }
  } else if (authMode === 'reset' || authMode === 'magic') {
    authMessage('Sprawdź skrzynkę (także spam) i kliknij link z maila.');
  } else if (authMode === 'newpass') {
    $('#kz-auth-password').value = $('#kz-auth-password2').value = '';
    if (started) {
      hideAuth();
      toast('Hasło zapisane. Od teraz logujesz się e-mailem i hasłem.', 'success', 4500);
    } else {
      location.replace(location.pathname);
    }
  }
}

function bindAuth() {
  $('#kz-auth-form').addEventListener('submit', submitAuth);
  $('#kz-login-view').addEventListener('click', (e) => {
    const modeBtn = e.target.closest('[data-mode]');
    if (modeBtn) {
      if (authMode === 'newpass' && started) return hideAuth();
      const next = modeBtn.dataset.mode;
      if (next !== authMode) withTransition(() => setAuthMode(next), 'auth');
    }
    const toggle = e.target.closest('.kz-pass-toggle');
    if (toggle) {
      const show = $('#kz-auth-password').type === 'password';
      ['#kz-auth-password', '#kz-auth-password2'].forEach((s) => ($(s).type = show ? 'text' : 'password'));
      toggle.textContent = show ? 'ukryj' : 'pokaż';
    }
  });
  $('#kz-login-local').addEventListener('click', () => {
    sessionStorage.setItem('kz-local-mode', '1');
    hideAuth();
    startApp();
    $('#kz-signin').hidden = false;
    $('#kz-account').textContent = 'tryb lokalny';
  });
}

async function boot() {
  if (!supabase) {
    $('#kz-account').textContent = 'tryb lokalny';
    startApp();
    return;
  }
  store.setStatusListener(setSyncStatus);
  $('#kz-sync').addEventListener('click', async () => {
    if (!['error', 'offline'].includes($('#kz-sync').dataset.state)) return;
    setSyncStatus('saving');
    await store.flush();
    if (await store.pull()) {
      loadState();
      renderAll();
    }
  });
  bindAuth();

  $('#kz-signout').addEventListener('click', async () => {
    const btn = $('#kz-signout');
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = 'Wylogowywanie…';
    // give unsent changes a short chance to upload — never wait long on a slow network
    if (store.hasPendingWrites()) await withTimeout(store.flush(), 3000).catch(() => {});
    if (store.hasPendingWrites() && !(await confirmDialog({ title: 'Niewysłane zmiany', message: 'Część zmian nie dotarła jeszcze na serwer. Wylogować mimo to?', confirm: 'Wyloguj', danger: true }))) {
      btn.disabled = false;
      btn.textContent = 'Wyloguj';
      return;
    }
    // revoke the session on the server if it answers quickly; the local session is removed regardless
    await withTimeout(supabase.auth.signOut({ scope: 'local' }), 1500).catch(() => {});
    clearStoredAuth();
    store.clearLocal();
    location.replace(location.pathname);
  });
  $('#kz-signin').addEventListener('click', () => {
    sessionStorage.removeItem('kz-local-mode');
    location.reload();
  });
  $('#kz-setpass').addEventListener('click', () => showAuth('newpass'));

  const cached = store.cachedAccount();
  let session = null;

  if (!isRecoveryRedirect && cached.uid && hasStoredSession()) {
    // Returning user: open instantly from the local cache. The session check and
    // first sync run in the background, so a slow network never blocks the app.
    store.prime(cached.uid);
    showSignedIn(cached.email);
    startApp();
    verifySessionInBackground(cached.uid);
    session = { cached: true };
  } else {
    try {
      ({ data: { session } } = await withTimeout(supabase.auth.getSession(), 8000));
    } catch (err) {
      // stored session couldn't be restored (usually a stalled token refresh) — start clean
      console.error('getSession failed', err);
      clearStoredAuth();
    }
  }

  if (session?.cached) {
    // already started above
  } else if (session && isRecoveryRedirect) {
    // came from a "reset password" email: signed in, but must pick a new password first
    showAuth('newpass');
  } else if (session) {
    const { id, email } = session.user;
    if (cached.uid && cached.uid !== id) {
      // another account's cache is on this device — switch before showing anything
      await withTimeout(store.connect(id, email), 8000).catch((err) => console.error('initial sync failed', err));
      showSignedIn(email);
      startApp();
    } else {
      store.prime(id);
      showSignedIn(email);
      startApp();
      syncInBackground(id, email);
    }
  } else if (sessionStorage.getItem('kz-local-mode')) {
    $('#kz-account').textContent = 'tryb lokalny';
    $('#kz-signin').hidden = false;
    startApp();
  } else {
    showAuth('login');
  }

  supabase.auth.onAuthStateChange((event, s) => {
    if (event === 'PASSWORD_RECOVERY') setTimeout(() => showAuth('newpass'), 0);
    // a link login completed in another tab
    else if (event === 'SIGNED_IN' && s && !session && authMode !== 'login') setTimeout(() => location.reload(), 0);
  });
}

boot();
