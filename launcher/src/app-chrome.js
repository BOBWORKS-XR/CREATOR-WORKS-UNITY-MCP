// Navigation is deliberately limited to public pages, never local app execution.
const publicPages = Object.freeze({
  hub: 'https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/blob/master/docs/CREATOR-HUB-PLAN.md',
  setup: 'https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/releases'
});

const toggle = document.getElementById('appSwitcherToggle');
const menu = document.getElementById('appSwitcherMenu');
const shell = document.getElementById('appSwitcherShell');
const scrim = document.getElementById('appSwitcherScrim');
const header = shell.closest('.header');
const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));

function isOpen() { return toggle.getAttribute('aria-expanded') === 'true'; }

function focusItem(index) {
  const item = items[index];
  item.focus({ preventScroll: true });
  const top = item.getBoundingClientRect().top - menu.getBoundingClientRect().top + menu.scrollTop;
  if (top < menu.scrollTop) menu.scrollTop = top;
  else if (top + item.offsetHeight > menu.scrollTop + menu.clientHeight)
    menu.scrollTop = top + item.offsetHeight - menu.clientHeight;
}

function closeMenu(restoreFocus = false) {
  if (restoreFocus) toggle.focus({ preventScroll: true });
  menu.inert = true;
  menu.setAttribute('aria-hidden', 'true');
  shell.classList.remove('expanded');
  header.classList.remove('drawer-open');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-label', 'Creator apps');
  toggle.title = 'Creator apps';
}

function openMenu(last = false) {
  menu.inert = false;
  menu.setAttribute('aria-hidden', 'false');
  shell.classList.add('expanded');
  header.classList.add('drawer-open');
  toggle.setAttribute('aria-expanded', 'true');
  toggle.setAttribute('aria-label', 'Close Creator apps');
  toggle.title = 'Close Creator apps';
  focusItem(last ? items.length - 1 : 0);
}

toggle.addEventListener('click', () => isOpen() ? closeMenu(true) : openMenu());
// Dismiss on click, not pointerdown: consume the whole gesture above the app.
scrim.addEventListener('click', () => closeMenu(true));
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
    focusItem(next);
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
  if (event.key === 'Escape' && isOpen()) {
    event.preventDefault();
    closeMenu(true);
  }
});
document.addEventListener('pointerdown', event => {
  if (event.target === scrim) return;
  if (!shell.contains(event.target)) closeMenu(menu.contains(document.activeElement));
});
document.addEventListener('focusin', event => {
  if (!shell.contains(event.target)) closeMenu();
});
