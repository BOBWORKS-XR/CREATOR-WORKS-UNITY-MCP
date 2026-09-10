// Navigation is deliberately limited to public pages, never local app execution.
const publicPages = Object.freeze({
  hub: 'https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/blob/master/docs/CREATOR-HUB-PLAN.md',
  setup: 'https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/releases'
});

const toggle = document.getElementById('appSwitcherToggle');
const menu = document.getElementById('appSwitcherMenu');
const switcher = toggle.closest('.app-switcher');
const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
document.getElementById('appSwitcherClose').addEventListener('click', () => closeMenu(true));

function closeMenu(restoreFocus = false) {
  menu.hidden = true;
  toggle.setAttribute('aria-expanded', 'false');
  if (restoreFocus) toggle.focus();
}

function openMenu(last = false) {
  menu.hidden = false;
  toggle.setAttribute('aria-expanded', 'true');
  items[last ? items.length - 1 : 0].focus();
}

toggle.addEventListener('click', () => menu.hidden ? openMenu() : closeMenu(true));
toggle.addEventListener('keydown', event => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    openMenu(event.key === 'ArrowUp');
  }
});

menu.addEventListener('keydown', event => {
  const current = items.indexOf(document.activeElement);
  let next;
  if (event.key === 'ArrowDown') next = (current + 1) % items.length;
  if (event.key === 'ArrowUp') next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
  if (event.key === 'Home') next = 0;
  if (event.key === 'End') next = items.length - 1;
  if (next !== undefined) {
    event.preventDefault();
    items[next].focus();
  }
  if (event.key === 'Tab') closeMenu(true);
  if (event.key === ' ' && document.activeElement?.matches('a[role="menuitem"]')) {
    event.preventDefault();
    document.activeElement.click();
  }
});

menu.addEventListener('click', async event => {
  const item = event.target.closest('[role="menuitem"]');
  if (!item) return;
  event.preventDefault();
  if (item.getAttribute('aria-disabled') === 'true') return;
  closeMenu(true);
  const url = publicPages[item.dataset.appLink];
  if (!url) return;
  try {
    await window.__TAURI__.shell.open(url);
  } catch {
    const message = document.createElement('div');
    message.className = 'toast error';
    message.setAttribute('role', 'alert');
    message.textContent = 'Could not open the public page. Please try again.';
    document.querySelector('.toast')?.remove();
    document.body.append(message);
    setTimeout(() => message.remove(), 4500);
  }
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !menu.hidden) {
    event.preventDefault();
    closeMenu(true);
  }
});
document.addEventListener('pointerdown', event => {
  if (!switcher.contains(event.target)) closeMenu(menu.contains(document.activeElement));
});
document.addEventListener('focusin', event => {
  if (!switcher.contains(event.target)) closeMenu();
});
