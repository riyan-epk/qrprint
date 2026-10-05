// Shared UI: icons, dialogs and toasts. window.UI.{icon,confirm,alert,prompt,toast}
// CSP-safe (builds DOM, no inline handlers). Any <i data-icon="name"></i> in the
// page is filled with the matching SVG when this script runs.
(function () {
  // 24x24 stroke icons.
  const PATHS = {
    printer: '<path d="M6 9V3h12v6"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="7" rx="1"/>',
    qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3M21 14v.01M14 21h3M21 17v4h-1"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8M10 9H8"/>',
    card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>',
    cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    checkCircle: '<circle cx="12" cy="12" r="10"/><path d="M8 12.5l2.5 2.5L16 9.5"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    alert: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    xCircle: '<circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="M21 2l-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
    mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 6l-10 7L2 6"/>',
    chat: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/>',
    chart: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 6-6"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    phone: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>',
    arrowRight: '<path d="M5 12h14M12 5l7 7-7 7"/>',
    arrowLeft: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
    menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
    close: '<path d="M18 6L6 18M6 6l12 12"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    store: '<path d="M3 9l1.5-5h15L21 9"/><path d="M4 9v11h16V9"/><path d="M3 9h18"/><path d="M10 20v-6h4v6"/>',
    zap: '<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
    pause: '<circle cx="12" cy="12" r="10"/><path d="M10 15V9M14 15V9"/>',
    play: '<circle cx="12" cy="12" r="10"/><path d="M10 8l6 4-6 4z"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    layers: '<path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/>',
    wifi: '<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0M12 20h.01"/>',
    undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
    rotate: '<path d="M21 3v5h-5"/><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/>',
    chevRight: '<path d="M9 18l6-6-6-6"/>',
    chevUp: '<path d="M18 15l-6-6-6 6"/>',
    chevDown: '<path d="M6 9l6 6 6-6"/>',
    idcard: '<rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="8" cy="11" r="2"/><path d="M5 16c.6-1.4 1.7-2 3-2s2.4.6 3 2M14 10h5M14 14h3"/>',
    portrait: '<rect x="4" y="2" width="16" height="20" rx="2"/><circle cx="12" cy="10" r="3"/><path d="M7.5 18a4.5 4.5 0 0 1 9 0"/>',
    camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
    files: '<path d="M15 2H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z"/><path d="M15 2v5h5"/><path d="M4 6v14a2 2 0 0 0 2 2h10"/>',
  };

  function icon(name, cls) {
    const p = PATHS[name] || PATHS.info;
    return `<span class="icon${cls ? ' ' + cls : ''}" aria-hidden="true"><svg viewBox="0 0 24 24">${p}</svg></span>`;
  }

  function hydrate(root) {
    (root || document).querySelectorAll('i[data-icon]').forEach((el) => {
      const wrap = document.createElement('span');
      wrap.innerHTML = icon(el.dataset.icon, el.className);
      el.replaceWith(wrap.firstChild);
    });
  }
  hydrate();

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  const DIALOG_ICON = { info: 'info', good: 'checkCircle', warn: 'alert', crit: 'xCircle', question: 'help' };

  function openDialog({ title, message, icon: kind = 'info', okText = 'OK', cancelText, danger = false, input = null }) {
    return new Promise((resolve) => {
      const backdrop = el('div', 'ui-backdrop');
      const dialog = el('div', 'ui-dialog');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');

      const ic = el('div', 'ui-icon ' + (['good', 'warn', 'crit'].includes(kind) ? kind : ''));
      ic.innerHTML = icon(DIALOG_ICON[kind] || 'info');
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
        cancelBtn = el('button', 'btn', cancelText || 'Cancel');
        actions.appendChild(cancelBtn);
      }
      const okBtn = el('button', 'btn ' + (danger ? 'btn-danger-solid' : 'btn-primary'), okText);
      actions.appendChild(okBtn);
      dialog.appendChild(actions);
      backdrop.appendChild(dialog);
      document.body.appendChild(backdrop);

      setTimeout(() => (field || okBtn).focus(), 30);

      function close(result) {
        backdrop.classList.add('closing');
        document.removeEventListener('keydown', onKey);
        setTimeout(() => { backdrop.remove(); resolve(result); }, 120);
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
    if (!toastWrap) {
      toastWrap = el('div', 'ui-toasts');
      toastWrap.setAttribute('role', 'status');
      document.body.appendChild(toastWrap);
    }
    const t = el('div', 'ui-toast ' + (['warn', 'crit'].includes(type) ? type : 'good'));
    t.innerHTML = icon(type === 'crit' ? 'xCircle' : type === 'warn' ? 'alert' : 'checkCircle');
    t.appendChild(el('span', null, message));
    toastWrap.appendChild(t);
    setTimeout(() => { t.classList.add('closing'); setTimeout(() => t.remove(), 200); }, ms);
  }

  window.UI = {
    icon,
    hydrate,
    confirm: (opts) => openDialog({ icon: 'question', okText: 'Confirm', cancelText: 'Cancel', ...opts }),
    alert: (opts) => openDialog({ okText: 'OK', ...opts }),
    prompt: (opts) => openDialog({ icon: 'question', okText: 'Save', input: opts.input || {}, ...opts }),
    toast,
  };
})();
