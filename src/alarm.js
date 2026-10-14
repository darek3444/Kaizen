// Pomodoro alarm that goes off on time even when the tab is in the background
// or the browser isn't focused:
//  - a Web Worker keeps time (worker timers aren't throttled like hidden-tab timers),
//  - the chime is pre-scheduled on the AudioContext timeline when the block starts,
//    so it plays at the exact moment even if the page's JS is asleep,
//  - a system notification shows up outside the browser.

const CHIME = [523.25, 659.25, 783.99, 1046.5];
const CYCLE_SEC = 1.3;     // one four-note chime every 1.3 s
const CHUNK_SEC = 45;      // how far ahead chimes are scheduled
const MAX_RING_MS = 5 * 60 * 1000; // stop by itself after 5 minutes

let ctx = null;
let bus = null;            // gain node all chimes go through — disconnecting it cancels them
let scheduledUntil = 0;    // ctx time up to which chimes are already scheduled
let ringing = false;
let ringStartedAt = 0;
let notification = null;
let onEnd = () => {};
let onDismiss = () => {};

const worker = createWorker();

function createWorker() {
  const src = `
    let endTimer = null, ringTimer = null;
    onmessage = (e) => {
      const m = e.data;
      if (m.cmd === 'arm') { clearTimeout(endTimer); endTimer = setTimeout(() => postMessage('end'), Math.max(0, m.at - Date.now())); }
      if (m.cmd === 'disarm') clearTimeout(endTimer);
      if (m.cmd === 'ring') { clearInterval(ringTimer); ringTimer = setInterval(() => postMessage('ring'), 15000); }
      if (m.cmd === 'silence') clearInterval(ringTimer);
    };`;
  try {
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    w.onmessage = (e) => {
      if (e.data === 'end') onEnd();
      if (e.data === 'ring') keepRinging();
    };
    return w;
  } catch {
    return null; // main-thread ticking still ends the block, just less punctually in the background
  }
}

/** Callbacks: `end` fires when an armed block runs out, `dismiss` when the alarm is stopped from a notification. */
export function setHandlers({ end, dismiss }) {
  onEnd = end;
  onDismiss = dismiss;
}

/** Must run inside a user gesture (e.g. the Start click) so the browser allows sound later. */
export function unlock() {
  try {
    ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch {
    ctx = null;
  }
}

export function notificationsState() {
  return 'Notification' in window ? Notification.permission : 'unsupported';
}
export async function requestNotifications() {
  if (notificationsState() !== 'default') return notificationsState();
  try {
    return await Notification.requestPermission();
  } catch {
    return notificationsState();
  }
}

/** Arms the alarm for a block ending at `endAt` (epoch ms). */
export function arm(endAt) {
  worker?.postMessage({ cmd: 'arm', at: endAt });
  cancelChimes();
  if (ctx) scheduleChimes(ctx.currentTime + Math.max(0, (endAt - Date.now()) / 1000), CHUNK_SEC);
}

/** Cancels an armed alarm (pause / reset / manual save). */
export function disarm() {
  worker?.postMessage({ cmd: 'disarm' });
  if (!ringing) cancelChimes();
}

export function isRinging() {
  return ringing;
}

/** Starts ringing (if the pre-scheduled chimes aren't already playing) and shows a notification. */
export function ring({ title, body }) {
  ringing = true;
  ringStartedAt = Date.now();
  worker?.postMessage({ cmd: 'ring' });
  if (ctx) {
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    if (scheduledUntil < ctx.currentTime + 1) scheduleChimes(ctx.currentTime, CHUNK_SEC);
  }
  if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]);
  if (notificationsState() === 'granted') {
    try {
      notification?.close();
      notification = new Notification(title, { body, tag: 'kaizen-timer', requireInteraction: true, silent: false, icon: '/icon.svg' });
      notification.onclick = () => {
        window.focus();
        silence();
        onDismiss();
      };
    } catch {
      notification = null;
    }
  }
}

export function silence() {
  ringing = false;
  worker?.postMessage({ cmd: 'silence' });
  cancelChimes();
  notification?.close();
  notification = null;
}

function keepRinging() {
  if (!ringing || !ctx) return;
  if (Date.now() - ringStartedAt > MAX_RING_MS) {
    silence();
    onDismiss();
    return;
  }
  if (scheduledUntil - ctx.currentTime < CHUNK_SEC / 2) scheduleChimes(Math.max(scheduledUntil, ctx.currentTime), CHUNK_SEC);
}

function scheduleChimes(from, seconds) {
  if (!bus) {
    bus = ctx.createGain();
    bus.connect(ctx.destination);
  }
  for (let t = from; t < from + seconds; t += CYCLE_SEC) chimeAt(t);
  scheduledUntil = from + seconds;
}

function cancelChimes() {
  if (bus) {
    try { bus.disconnect(); } catch {}
    bus = null;
  }
  scheduledUntil = 0;
}

function chimeAt(start) {
  CHIME.forEach((freq, i) => {
    const t = start + i * 0.16;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.28, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    osc.connect(gain).connect(bus);
    osc.start(t);
    osc.stop(t + 0.55);
  });
}
