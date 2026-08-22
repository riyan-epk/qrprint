// Shared UI: beautiful dialogs + toasts. window.UI.{confirm,alert,prompt,toast}
// CSP-safe (builds DOM, no inline handlers). Drop-in replacements for the native
// confirm()/alert()/prompt() — same behavior, nicer look.
(function () {
  const ICONS = { info: 'ℹ️', good: '✅', warn: '⚠️', crit: '⛔', question: '❓' };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function openDialog({ title, message, icon = 'info', okText = 'OK', cancelText, danger = false, input = null }) {
    return new Promise((resolve) => {
      const backdrop = el('div', 'ui-backdrop');
      const dialog = el('div', 'ui-dialog');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');

      const ic = el('div', 'ui-icon ' + (icon === 'good' ? 'good' : icon === 'warn' ? 'warn' : icon === 'crit' ? 'crit' : ''));
      ic.textContent = ICONS[icon] || ICONS.info;
      dialog.appendChild(ic);

      if (title) dialog.appendChild(el('h2', 'ui-title', title));
      if (message) dialog.appendChild(el('p', 'ui-msg', message));

      let field = null;
      if (input) {
        field = el('input', 'ui-input');
        field.type = input.password ? 'password' : 'text';
        if (input.placeholder) field.placeholder = input.placeholder;
        if (input.value) field.value = input.value;
        dialog.appendChild(field);
      }

      const actions = el('div', 'ui-actions');
      let cancelBtn = null;
      const hasCancel = cancelText || input;
      if (hasCancel) {
        cancelBtn = el('button', 'ui-btn', cancelText || 'Cancel');
        actions.appendChild(cancelBtn);
      }
      const okBtn = el('button', 'ui-btn ' + (danger ? 'danger' : 'primary'), okText);
      actions.appendChild(okBtn);
      dialog.appendChild(actions);
      backdrop.appendChild(dialog);
      document.body.appendChild(backdrop);

      if (field) setTimeout(() => field.focus(), 40); else setTimeout(() => okBtn.focus(), 40);

      function close(result) {
        backdrop.classList.add('closing');
        setTimeout(() => { backdrop.remove(); document.removeEventListener('keydown', onKey); resolve(result); }, 160);
      }
      function onKey(e) {
        if (e.key === 'Escape' && hasCancel) close(input ? null : false);
        else if (e.key === 'Enter') { e.preventDefault(); okBtn.click(); }
      }
      okBtn.addEventListener('click', () => close(input ? (field ? field.value : '') : true));
      if (cancelBtn) cancelBtn.addEventListener('click', () => close(input ? null : false));
      backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop && hasCancel) close(input ? null : false); });
      document.addEventListener('keydown', onKey);
    });
  }

  let toastWrap = null;
  function toast(message, type = 'good', ms = 2600) {
    if (!toastWrap) { toastWrap = el('div', 'ui-toasts'); document.body.appendChild(toastWrap); }
    const t = el('div', 'ui-toast ' + (type === 'good' ? 'good' : type === 'warn' ? 'warn' : type === 'crit' ? 'crit' : ''));
    const ic = el('span', 'ui-t-ic'); ic.textContent = type === 'crit' ? '⛔' : type === 'warn' ? '⚠️' : '✅';
    t.appendChild(ic); t.appendChild(el('span', null, message));
    toastWrap.appendChild(t);
    setTimeout(() => { t.classList.add('closing'); setTimeout(() => t.remove(), 240); }, ms);
  }

  window.UI = {
    confirm: (opts) => openDialog({ icon: 'question', okText: 'Confirm', cancelText: 'Cancel', ...opts }),
    alert: (opts) => openDialog({ okText: 'OK', ...opts }),
    prompt: (opts) => openDialog({ icon: 'question', okText: 'Save', input: opts.input || {}, ...opts }),
    toast,
  };
})();
