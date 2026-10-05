// Homepage: mobile menu.
(function () {
  const btn = document.getElementById('menuBtn');
  const nav = document.getElementById('siteNav');
  if (!btn || !nav) return;
  function set(open) {
    nav.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open));
    btn.innerHTML = UI.icon(open ? 'close' : 'menu');
  }
  btn.addEventListener('click', () => set(!nav.classList.contains('open')));
  nav.addEventListener('click', (e) => { if (e.target.closest('a')) set(false); });
})();
