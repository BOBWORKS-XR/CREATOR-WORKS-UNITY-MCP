(() => {
  const POLICY_VERSION = '2026-09-28-v1';
  const KEY = 'creator-usage-terms.mcp';

  function requireAcceptance() {
    if (window.__CREATOR_HOSTED_TERMS_ACCEPTED__ === POLICY_VERSION) return Promise.resolve(true);
    let saved;
    try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { saved = null; }
    if (saved?.policyVersion === POLICY_VERSION && typeof saved.acceptedAt === 'string') return Promise.resolve(true);

    const dialog = document.querySelector('#usage-terms-dialog');
    const checkbox = document.querySelector('#usage-terms-checkbox');
    const submit = document.querySelector('#usage-terms-continue');
    const error = document.querySelector('#usage-terms-error');
    const locked = [...document.body.children].filter(node => node !== dialog && !node.inert);
    locked.forEach(node => { node.inert = true; });
    dialog.addEventListener('cancel', event => event.preventDefault());
    checkbox.addEventListener('change', () => { submit.disabled = !checkbox.checked; });
    dialog.showModal();
    return new Promise(resolve => {
      submit.addEventListener('click', () => {
        if (!checkbox.checked) return;
        try {
          localStorage.setItem(KEY, JSON.stringify({ policyVersion: POLICY_VERSION, acceptedAt: new Date().toISOString() }));
        } catch {
          error.textContent = 'The acknowledgement could not be saved. Enable app storage and try again; the app will remain locked until it is recorded.';
          error.hidden = false;
          return;
        }
        dialog.close();
        locked.forEach(node => { node.inert = false; });
        resolve(true);
      });
    });
  }

  window.CreatorUsageTerms = Object.freeze({ requireAcceptance });
})();
