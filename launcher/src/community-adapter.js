(() => {
  const guarded = new Set(['download_community_package', 'choose_community_project', 'install_community_menu', 'queue_community_import']);
  const allowed = new Set([...guarded, 'community_catalogue', 'open_community_link', 'community_projects', 'community_import_status', 'community_transfer_status', 'cancel_community_transfer']);
  window.CreatorCommunityInvoke = async (command, args = {}) => {
    await window.CreatorRuntime.ready;
    if (window.CreatorRuntime.hosted || !allowed.has(command)) {
      throw new Error('Use Creator Plugins in Hub for community actions.');
    }
    const invoke = () => window.CreatorRuntime.invoke(command, args);
    if (guarded.has(command)) {
      if (!window.CreatorMcpOperations) throw new Error('MCP is still opening. Try again shortly.');
      return window.CreatorMcpOperations.run(invoke);
    }
    return invoke();
  };

  window.CreatorMcpViews = Object.freeze({
    show(name) {
      if (!['mcp', 'plugins'].includes(name)) return;
      if (window.CreatorRuntime.hosted) name = 'mcp';
      const plugins = name === 'plugins';
      for (const id of ['mcp', 'plugins']) {
        const view = document.getElementById(`view-${id}`);
        const hidden = id !== name;
        view.hidden = hidden;
        view.inert = hidden;
        view.classList.toggle('hidden', hidden);
        const item = document.querySelector(`[data-local-view="${id}"]`);
        if (!hidden) item.setAttribute('aria-current', 'page');
        else item.removeAttribute('aria-current');
      }
      document.querySelector('.app-context').textContent = plugins ? 'Community creations' : 'Unity project connections';
      if (plugins) {
        void window.CreatorCommunity.show();
        document.getElementById('plugins-title')?.focus();
      } else window.CreatorCommunity?.closePreview();
    }
  });
  void window.CreatorRuntime.ready.then(() => {
    if (window.CreatorRuntime.hosted) window.CreatorMcpViews.show('mcp');
  }).catch(() => {});
})();
