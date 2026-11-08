(() => {
  const form = document.getElementById('link-form');
  const input = document.getElementById('session-token');
  const result = document.getElementById('result');
  const button = document.getElementById('submit-btn');
  const code = new URLSearchParams(location.hash.replace(/^#/, '')).get('code') || '';
  if (code) history.replaceState(null, '', location.pathname);
  if (!/^[a-f0-9]{64}$/i.test(code)) {
    result.textContent = 'رابط الربط غير صالح. ارجع إلى Telegram واكتب /connect.';
    result.className = 'link-result error';
    form.hidden = true;
    return;
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const sessionToken = input.value.trim();
    if (!sessionToken) return;
    button.disabled = true;
    button.textContent = 'جارٍ التحقق…';
    result.textContent = '';
    result.className = 'link-result';
    try {
      const response = await fetch('/api/telegram/link/complete', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, session_token: sessionToken }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.verified) throw new Error(data.detail || 'تعذر التحقق من جلسة ExpertOption.');
      input.value = '';
      result.textContent = 'تم ربط الحساب بنجاح. جارٍ فتح ROZLF…';
      result.className = 'link-result ok';
      setTimeout(() => location.replace('/'), 700);
    } catch (error) {
      result.textContent = String(error.message || error);
      result.className = 'link-result error';
      button.disabled = false;
      button.textContent = 'تحقق واربط الحساب';
    }
  });
})();
