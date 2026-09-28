(() => {
  const dialog = document.querySelector('#context-help-dialog');
  document.querySelector('#context-help-open').addEventListener('click', () => dialog.showModal());
  document.querySelector('#context-help-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
})();
