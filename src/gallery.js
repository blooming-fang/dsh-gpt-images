/**
 * Progressive enhancement for this plugin's Markdown only. The source remains
 * in place for React reconciliation, history, copy/export and script-free clients.
 * This function is serialized into the host index: keep every dependency inside.
 */
export function installImageGallery(options = {}, referenceFactory) {
  const key = '__dshGptImagesGallery';
  window[key]?.dispose?.();
  const style = document.createElement('style');
  style.dataset.dgiStyle = '';
  style.textContent = options.css || '';
  document.head.append(style);
  const controllers = new Map();
  const queued = new Set();
  const sourceSelector = 'img[alt^="生成的图片 "][src*="/dsh-gpt-images/"]';
  const filename = /\/dsh-gpt-images\/generated-[a-f0-9]{32}\.(png|jpg|webp|gif)$/;
  const aborter = new AbortController();
  const events = { signal: aborter.signal };
  let observer;
  let frame;
  let viewer;
  let viewerOwner;
  let viewerURL;
  let viewerClose;
  let disposed = false;
  const icons = {
    image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m21 15-5-5L5 21"/>',
    left: '<path d="m14 6-6 6 6 6"/>', right: '<path d="m10 6 6 6-6 6"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    reference: '<path d="M9 7h10v10H9zM5 4v13a3 3 0 0 0 3 3h9M14 10v4m-2-2h4"/>',
    folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v2M3 7h16a2 2 0 0 1 2 2l-2 11H5L3 7Z"/>',
    open: '<path d="M14 3h7v7m0-7L10 14M10 3H4v17h17v-6"/>',
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  };
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    // The only HTML assigned here is this closed, static icon table.
    svg.innerHTML = icons[name] || '';
    return svg;
  }
  function button(label, name, action, className = '') {
    const node = el('button', 'dgi-button ' + className);
    node.type = 'button';
    node.title = label;
    node.setAttribute('aria-label', label);
    if (name) node.append(icon(name));
    if (!className.includes('dgi-icon-button')) node.append(document.createTextNode(label));
    node.addEventListener('click', action);
    return node;
  }
  function link(label, name, href) {
    const node = el('a', 'dgi-link', label);
    node.prepend(icon(name));
    node.href = href;
    node.target = '_blank';
    node.rel = 'noopener noreferrer';
    node.referrerPolicy = 'no-referrer';
    return node;
  }
  const referenceBridge = options.referenceToken && referenceFactory?.(options, {
    signal: aborter.signal, button, icon, isDisposed: () => disposed,
    notify: (controller, feedback, text) => {
      if (disposed) return;
      if (feedback?.isConnected) feedback.textContent = text;
      else if (controller.root.isConnected) announce(controller, text);
    },
    closePreview: (controller) => { if (viewerOwner === controller) viewerClose?.(); },
  });
  const pendingReveals = new Set();
  function revealEndpoint() {
    if (!options.revealToken || !options.revealEndpoint) return '';
    const loopback = (host) => host === 'localhost' || host === '[::1]' || /^127[.]\d+[.]\d+[.]\d+$/.test(host);
    try {
      const target = new URL(options.revealEndpoint);
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || !loopback(target.hostname)) return '';
      if (['http:', 'https:'].includes(location.protocol)) {
        if (!loopback(location.hostname)) return '';
        // Use the current local page origin rather than a stale listening port.
        return new URL('/dsh-gpt-images/reveal', location.origin).href;
      }
      return location.protocol === 'dsh-app:' ? target.href : '';
    } catch { return ''; }
  }
  function folderButton(item, controller, feedback) {
    const endpoint = revealEndpoint();
    const notify = (text) => {
      if (disposed) return;
      if (feedback?.isConnected) feedback.textContent = text;
      else if (controller.root.isConnected) announce(controller, text);
    };
    const node = button('打开文件夹', 'folder', async () => {
      if (!endpoint || pendingReveals.has(item.url)) return;
      pendingReveals.add(item.url);
      node.disabled = true;
      node.replaceChildren(icon('folder'), document.createTextNode('正在打开…'));
      const request = new AbortController();
      const cancel = () => request.abort();
      aborter.signal.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(cancel, 15000);
      try {
        const filename = new URL(item.url).pathname.split('/').pop();
        const response = await fetch(endpoint, {
          method: 'POST', credentials: 'same-origin', signal: request.signal,
          headers: { 'content-type': 'application/json', 'x-dsh-gpt-images-token': options.revealToken },
          body: JSON.stringify({ filename, ...(item.path ? { path: item.path } : {}) }),
        });
        const result = await response.json();
        if (!response.ok || result.ok !== true) {
          notify(typeof result.message === 'string' ? result.message.slice(0, 160) : '打开失败，请刷新页面后重试');
        } else {
          if (result.selected === true && result.foreground === true) {
            notify(result.location === 'cache' ? '已打开文件夹并选中缓存图片（原文件未找到或已更改）' : '已打开文件夹并选中图片');
          } else if (result.selected === true && result.foreground === false) {
            notify(result.location === 'cache' ? '缓存图片已选中，但资源管理器仍在后台，请从任务栏切换查看' : '图片已选中，但资源管理器仍在后台，请从任务栏切换查看');
          } else {
            notify('系统已接收打开请求，但未确认窗口显示，请重试或手动打开保存位置');
          }
        }
      } catch {
        if (!disposed) notify('无法打开文件夹，请确认 DSH 正在本机运行，或刷新页面后重试');
      } finally {
        clearTimeout(timer); aborter.signal.removeEventListener('abort', cancel);
        pendingReveals.delete(item.url);
        node.disabled = !endpoint;
        node.replaceChildren(icon('folder'), document.createTextNode('打开文件夹'));
      }
    });
    if (!endpoint) {
      node.disabled = true;
      node.title = '请在运行 DSH 的本机打开页面，并更新/重载插件后刷新';
    } else node.title = '打开文件资源管理器并选中这张图片';
    return node;
  }
  function validSource(image) {
    if (image.closest('.dgi-gallery,.dgi-viewer') || !/^生成的图片 \d+$/.test(image.alt)) return false;
    try {
      const url = new URL(image.src);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && filename.test(url.pathname);
    } catch { return false; }
  }
  function rootOf(image) {
    const paragraph = image.closest('p');
    // Markdown paragraphs are direct children of one document root. Do not group
    // across messages, tool results, list items, tables or arbitrary page sections.
    return paragraph?.parentElement?.tagName === 'DIV' ? paragraph.parentElement : undefined;
  }
  function readItems(root) {
    const items = [];
    for (const image of root.querySelectorAll(sourceSelector)) {
      if (!validSource(image) || rootOf(image) !== root) continue;
      const paragraph = image.closest('p');
      const next = paragraph.nextElementSibling;
      let metadata;
      let path = '';
      if (next?.tagName === 'P') {
        const anchor = [...next.querySelectorAll('a[href]')].find((a) => {
          try { const u = new URL(a.href); const v = new URL(image.src); return u.origin === v.origin && u.pathname === v.pathname && u.searchParams.get('download') === '1'; } catch { return false; }
        });
        const code = next.querySelector('code');
        if (anchor && anchor.textContent.trim() === '下载原图' && code) {
          path = code.textContent;
          // Hide only the exact plugin paragraph; appended user/model prose stays visible.
          if (next.textContent.trim() === '下载原图 · 已保存到 ' + path) metadata = next;
        }
      }
      const url = new URL(image.src);
      url.searchParams.delete('download');
      const download = new URL(url);
      download.searchParams.set('download', '1');
      items.push({ url: url.href, download: download.href, label: image.alt, path, image, paragraph, metadata, format: url.pathname.split('.').pop().toUpperCase() });
    }
    return items;
  }
  function hide(node, controller) {
    if (!node) return;
    node.dataset.dgiSource = 'hidden';
    controller.hidden.add(node);
  }
  function announce(controller, text) {
    controller.toast.textContent = text;
    clearTimeout(controller.toastTimer);
    controller.toastTimer = setTimeout(() => { controller.toast.textContent = ''; }, 3000);
  }
  async function copyPath(controller, path, details) {
    try {
      await navigator.clipboard.writeText(path);
      if (controller.root.isConnected) announce(controller, '保存路径已复制');
    } catch {
      details.open = true;
      const code = details.querySelector('code');
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      selection.removeAllRanges(); selection.addRange(range);
      announce(controller, '无法自动复制，已选中路径，可手动复制');
    }
  }
  function reducedMotion() { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function stepTrack(controller, direction) {
    controller.track.scrollBy({ left: direction * Math.max(200, controller.track.clientWidth * .8), behavior: reducedMotion() ? 'instant' : 'smooth' });
  }
  function updateNav(controller) {
    const { track, previous, next } = controller;
    const overflow = track.scrollWidth > track.clientWidth + 2;
    previous.hidden = next.hidden = !overflow;
    previous.disabled = track.scrollLeft < 2;
    next.disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 2;
    controller.hint.textContent = overflow ? '横向滑动查看更多' : '点击图片放大';
  }
  function openViewer(controller, selected, trigger) {
    if (viewer) viewerClose();
    const dialog = el('dialog', 'dgi-viewer');
    dialog.setAttribute('aria-label', '生成图片预览');
    const inner = el('div', 'dgi-viewer-inner');
    const header = el('div', 'dgi-viewer-head');
    const title = el('h2', 'dgi-viewer-title');
    const close = button('关闭预览（Esc）', 'close', () => dialog.close(), 'dgi-icon-button');
    header.append(title, close);
    const stage = el('div', 'dgi-viewer-stage');
    const image = el('img');
    image.referrerPolicy = 'no-referrer';
    image.decoding = 'async';
    const status = el('div', 'dgi-status');
    status.setAttribute('role', 'status');
    const prev = button('上一张图片', 'left', () => show(selected - 1), 'dgi-icon-button dgi-viewer-prev');
    const next = button('下一张图片', 'right', () => show(selected + 1), 'dgi-icon-button dgi-viewer-next');
    stage.append(image, status, prev, next);
    const footer = el('div', 'dgi-viewer-foot');
    const hint = el('span', 'dgi-meta');
    const actions = el('div', 'dgi-actions');
    const feedback = el('div', 'dgi-toast');
    feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
    footer.append(hint, actions, feedback);
    inner.append(header, stage, footer);
    dialog.append(inner);
    document.body.append(dialog);
    viewer = dialog;
    viewerOwner = controller;
    viewerClose = () => dialog.close();
    function show(index) {
      if (index < 0 || index >= controller.items.length) return;
      selected = index;
      const item = controller.items[index];
      viewerURL = item.url;
      title.textContent = item.label + ' / 共 ' + controller.items.length + ' 张';
      image.alt = item.label;
      status.hidden = false; status.dataset.state = 'loading'; status.textContent = '正在加载原图…';
      image.src = item.url;
      prev.disabled = index === 0; next.disabled = index === controller.items.length - 1;
      prev.hidden = next.hidden = controller.items.length === 1;
      hint.textContent = controller.items.length > 1 ? '← → 切换图片 · Esc 关闭' : 'Esc 关闭预览';
      feedback.textContent = '';
      actions.replaceChildren(...(referenceBridge ? [referenceBridge.createButton(item, controller, feedback)] : []), folderButton(item, controller, feedback), link('新窗口打开', 'open', item.url));
    }
    image.addEventListener('load', () => { status.hidden = true; });
    image.addEventListener('error', () => { status.hidden = false; status.dataset.state = 'error'; status.textContent = '原图加载失败，可在新窗口打开或返回重试'; });
    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); show(selected + (event.key === 'ArrowLeft' ? -1 : 1)); }
    });
    dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (viewer === dialog) { viewer = undefined; viewerOwner = undefined; viewerURL = undefined; viewerClose = undefined; }
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    }, { once: true });
    show(selected);
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else { dialog.remove(); viewer = undefined; viewerOwner = undefined; viewerURL = undefined; viewerClose = undefined; window.open(controller.items[selected].url, '_blank', 'noopener,noreferrer'); }
  }
  function makeCard(item, index, controller) {
    const card = el('article', 'dgi-card');
    card.setAttribute('aria-label', item.label);
    const preview = el('button', 'dgi-preview');
    preview.type = 'button';
    preview.setAttribute('aria-label', '放大查看' + item.label);
    const image = el('img');
    image.alt = item.label;
    image.loading = index > 1 ? 'lazy' : 'eager';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    const status = el('span', 'dgi-status', '正在加载图片…');
    status.setAttribute('role', 'status');
    const expand = el('span', 'dgi-expand', '放大查看');
    preview.append(image, status, expand);
    preview.addEventListener('click', () => openViewer(controller, controller.items.findIndex((i) => i.url === item.url), preview));
    const body = el('div', 'dgi-card-body');
    const heading = el('div', 'dgi-card-heading');
    const label = el('span', 'dgi-card-label', '图片 ' + String(index + 1).padStart(2, '0'));
    const meta = el('span', 'dgi-meta', item.format);
    heading.append(label, meta);
    const actions = el('div', 'dgi-actions');
    actions.append(...(referenceBridge ? [referenceBridge.createButton(item, controller)] : []), folderButton(item, controller), link('原图', 'open', item.url));
    const retry = button('重新加载', null, () => {
      status.hidden = false; status.dataset.state = 'loading'; status.textContent = '正在重新加载…'; retry.hidden = true;
      const url = new URL(item.url); url.searchParams.set('_retry', Date.now().toString()); image.src = url.href;
    });
    retry.hidden = true;
    actions.append(retry);
    body.append(heading, actions);
    if (item.path) {
      const details = el('details', 'dgi-details');
      details.append(el('summary', '', '已保存 · 查看位置'), el('code', 'dgi-path', item.path));
      details.append(button('复制路径', 'copy', () => copyPath(controller, item.path, details)));
      body.append(details);
    }
    image.addEventListener('load', () => {
      status.hidden = true; retry.hidden = true;
      meta.textContent = image.naturalWidth + ' × ' + image.naturalHeight + ' · ' + item.format;
    });
    image.addEventListener('error', () => {
      status.hidden = false; status.dataset.state = 'error'; status.textContent = '图片暂时无法加载'; retry.hidden = false;
    });
    image.src = item.url;
    card.append(preview, body);
    return card;
  }
  function createController(root) {
    const controller = { root, hidden: new Set(), items: [], cards: new Map(), toastTimer: undefined };
    root.dataset.dgiRoot = '';
    const shell = el('section', 'dgi-gallery');
    shell.setAttribute('aria-label', '生成的图片');
    const header = el('div', 'dgi-head');
    const title = el('h3', 'dgi-title');
    const count = el('span', 'dgi-count');
    title.append(icon('image'), document.createTextNode('图片结果'), count);
    const nav = el('div', 'dgi-nav');
    const hint = el('span', 'dgi-hint', '点击图片放大');
    const previous = button('向左滚动图片', 'left', () => stepTrack(controller, -1), 'dgi-icon-button');
    const next = button('向右滚动图片', 'right', () => stepTrack(controller, 1), 'dgi-icon-button');
    nav.append(hint, previous, next); header.append(title, nav);
    const track = el('div', 'dgi-track');
    track.tabIndex = 0;
    track.setAttribute('role', 'region');
    track.setAttribute('aria-label', '图片横向列表，可使用左右方向键滚动');
    const toast = el('div', 'dgi-toast');
    toast.setAttribute('role', 'status'); toast.setAttribute('aria-live', 'polite');
    shell.append(header, track, toast);
    Object.assign(controller, { shell, count, track, previous, next, hint, toast });
    track.addEventListener('scroll', () => updateNav(controller), { passive: true });
    track.addEventListener('keydown', (event) => {
      if (event.target !== track || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault(); stepTrack(controller, event.key === 'ArrowLeft' ? -1 : 1);
    });
    if (typeof ResizeObserver === 'function') {
      controller.resize = new ResizeObserver(() => updateNav(controller)); controller.resize.observe(track);
    }
    controllers.set(root, controller);
    // Append an owned island; never move or delete nodes owned by React.
    root.append(shell);
    return controller;
  }
  function cleanup(controller) {
    controller.resize?.disconnect(); clearTimeout(controller.toastTimer);
    for (const node of controller.hidden) node.removeAttribute('data-dgi-source');
    controller.root.removeAttribute('data-dgi-root');
    controller.shell.remove(); controllers.delete(controller.root);
    if (viewerOwner === controller) viewerClose?.();
  }
  function enhance(root) {
    if (!root.isConnected) return;
    const items = readItems(root);
    let controller = controllers.get(root);
    if (!items.length) { if (controller) cleanup(controller); return; }
    if (!controller) controller = createController(root);
    if (controller.shell.parentElement !== root) root.append(controller.shell);
    // Streaming reconciliation may reuse a formerly hidden paragraph for prose.
    for (const node of controller.hidden) node.removeAttribute('data-dgi-source');
    controller.hidden.clear();
    if (viewerOwner === controller && !items.some((item) => item.url === viewerURL)) viewerClose?.();
    controller.items = items;
    controller.count.textContent = String(items.length);
    controller.shell.dataset.single = String(items.length === 1);
    const active = new Set(items.map((item) => item.url));
    for (const [url, entry] of controller.cards) if (!active.has(url)) { entry.card.remove(); controller.cards.delete(url); }
    for (const [index, item] of items.entries()) {
      const fingerprint = JSON.stringify([item.path, item.label, index]);
      let entry = controller.cards.get(item.url);
      if (!entry || entry.fingerprint !== fingerprint) {
        const card = makeCard(item, index, controller);
        if (entry) entry.card.replaceWith(card); else controller.track.append(card);
        entry = { card, fingerprint }; controller.cards.set(item.url, entry);
      }
      if (controller.track.children[index] !== entry.card) controller.track.insertBefore(entry.card, controller.track.children[index] || null);
      hide(item.image, controller);
      if (!item.paragraph.textContent.trim() && item.paragraph.querySelectorAll('img').length === 1) hide(item.paragraph, controller);
      hide(item.metadata, controller);
    }
    // Only hide our exact generated section heading and its adjacent separator.
    const before = items[0].paragraph.previousElementSibling;
    if (before?.tagName === 'H3' && /^图片结果 · \d+ 张$/.test(before.textContent.trim())) {
      hide(before, controller);
      if (before.previousElementSibling?.tagName === 'HR') hide(before.previousElementSibling, controller);
    }
    updateNav(controller);
  }
  function queue(root) {
    if (!root || disposed) return;
    queued.add(root);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      for (const controller of controllers.values()) if (!controller.root.isConnected) cleanup(controller);
      const pending = [...queued]; queued.clear();
      for (const candidate of pending) enhance(candidate);
    });
  }
  function inspect(node) {
    const element = node.nodeType === 1 ? node : node.parentElement;
    if (!element || element.closest('.dgi-gallery,.dgi-viewer')) return;
    // Mutations may concern a metadata paragraph after its image was inserted.
    for (const root of controllers.keys()) if (root === element || root.contains(element)) queue(root);
    if (element.matches(sourceSelector) && validSource(element)) queue(rootOf(element));
    for (const image of element.querySelectorAll(sourceSelector)) if (validSource(image)) queue(rootOf(image));
  }
  function start() {
    if (disposed) return;
    inspect(document.body);
    observer = new MutationObserver((records) => {
      for (const controller of [...controllers.values()]) if (!controller.root.isConnected) cleanup(controller);
      for (const record of records) {
        if (record.target.nodeType === 1 && record.target.closest('.dgi-gallery,.dgi-viewer')) continue;
        inspect(record.target);
        for (const node of record.addedNodes) inspect(node);
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['src', 'href', 'alt'] });
  }
  function dispose() {
    disposed = true; aborter.abort(); observer?.disconnect(); if (frame) cancelAnimationFrame(frame);
    viewerClose?.(); for (const controller of [...controllers.values()]) cleanup(controller);
    queued.clear(); pendingReveals.clear(); style.remove(); delete window[key];
  }
  window[key] = { dispose, version: 1 };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { ...events, once: true });
}
