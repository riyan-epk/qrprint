// Shop dashboard sign-in. On success the server has set the session cookie, so
// we just go to the dashboard (which the server only serves when signed in).
const $ = (id) => document.getElementById(id);

$('loginShop').focus();

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const shopId = $('loginShop').value.trim();
  const password = $('loginPw').value;
  const err = $('loginErr');
  err.classList.add('hidden');
  if (!shopId) { $('loginShop').focus(); return; }

  const btn = $('loginBtn');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    const r = await fetch('/api/auth/shop/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopId, password }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Sign in failed. Please try again.');
    location.replace('/dashboard/');
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
    $('loginPw').value = '';
    $('loginPw').focus();
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});
