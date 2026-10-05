// Provider console sign-in: the admin key is exchanged for an httpOnly session
// cookie, so it isn't kept in the page.
const $ = (id) => document.getElementById(id);

$('key').focus();

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = $('key').value.trim();
  const err = $('loginErr');
  err.classList.add('hidden');
  if (!key) { $('key').focus(); return; }

  const btn = $('loginBtn');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    const r = await fetch('/api/auth/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Sign in failed.');
    location.replace('/admin/');
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
    $('key').select();
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});
