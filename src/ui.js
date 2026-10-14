// In-app replacements for alert()/confirm(): a styled, animated dialog and toasts.

const escapeHtml = (str) =>
  String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const EXIT_MS = 180;

/**
 * Shows a dialog and resolves with the chosen action's `value`
 * (or `null` when dismissed with Esc / backdrop click).
 * actions: [{ label, value, variant: 'primary' | 'secondary' | 'danger' | 'ghost' }]
 */
export function dialog({ title, message = '', actions }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const root = document.createElement('div');
    root.className = 'kz-modal';
    root.innerHTML = `
      <div class="kz-modal-backdrop"></div>
      <div class="kz-modal-box" role="dialog" aria-modal="true" aria-labelledby="kz-modal-title">
        <h3 id="kz-modal-title">${escapeHtml(title)}</h3>
        ${message ? `<p>${escapeHtml(message)}</p>` : ''}
        <div class="kz-modal-actions">
          ${actions.map((a, i) => `<button type="button" class="kz-btn ${a.variant || 'secondary'}" data-i="${i}">${escapeHtml(a.label)}</button>`).join('')}
        </div>
      </div>`;
    document.body.appendChild(root);
    requestAnimationFrame(() => root.classList.add('open'));

    const close = (value) => {
      document.removeEventListener('keydown', onKey, true);
      root.classList.remove('open');
      root.classList.add('closing');
      setTimeout(() => root.remove(), EXIT_MS);
      prevFocus?.focus?.({ preventScroll: true });
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      if (e.key === 'Tab') {
        // keep focus inside the dialog
        const btns = [...root.querySelectorAll('button')];
        const i = btns.indexOf(document.activeElement);
        e.preventDefault();
        btns[(i + (e.shiftKey ? -1 : 1) + btns.length) % btns.length].focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    root.querySelector('.kz-modal-backdrop').addEventListener('click', () => close(null));
    root.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => close(actions[b.dataset.i].value)));
    const primary = root.querySelector('.kz-btn.primary, .kz-btn.danger') || root.querySelector('.kz-btn');
    primary.focus({ preventScroll: true });
  });
}

export async function confirmDialog({ title, message, confirm = 'OK', cancel = 'Anuluj', danger = false }) {
  const res = await dialog({
    title,
    message,
    actions: [
      { label: cancel, value: false, variant: 'ghost' },
      { label: confirm, value: true, variant: danger ? 'danger' : 'primary' },
    ],
  });
  return res === true;
}

let toastWrap;
/** Brief notification at the bottom of the screen. type: 'info' | 'success' | 'error' */
export function toast(text, type = 'info', ms = 3200) {
  if (!toastWrap) {
    toastWrap = document.createElement('div');
    toastWrap.className = 'kz-toasts';
    toastWrap.setAttribute('role', 'status');
    toastWrap.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastWrap);
  }
  const el = document.createElement('div');
  el.className = `kz-toast ${type}`;
  el.textContent = text;
  toastWrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add('open'));
  const dismiss = () => {
    el.classList.remove('open');
    setTimeout(() => el.remove(), 250);
  };
  el.addEventListener('click', dismiss);
  setTimeout(dismiss, ms);
}
