/** Serialized browser-only bridge. Use the host's normal image paste intake,
 * never private React state, clipboard writes, prompt submission or draft edits. */
export function createImageReferenceBridge(options, services) {
  const pending = new Set();
  let navigation = 0;
  const navigate = () => { navigation++; };
  window.addEventListener('hashchange', navigate, { signal: services.signal });
  window.addEventListener('popstate', navigate, { signal: services.signal });
  const media = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  function endpoint() {
    if (!options.referenceToken || !options.referenceEndpoint) return '';
    try {
      const value = location.protocol === 'dsh-app:' ? options.localReferenceEndpoint || options.referenceEndpoint : options.referenceEndpoint;
      const target = new URL(value);
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || !target.pathname.endsWith('/dsh-gpt-images/reference')) return '';
      if (['http:', 'https:'].includes(location.protocol)) {
        if (target.origin !== location.origin) return new URL(target.pathname, location.origin).href;
        return target.href;
      }
      if (location.protocol !== 'dsh-app:') return '';
      const host = target.hostname;
      return host === 'localhost' || host === '[::1]' || /^127[.]\d+[.]\d+[.]\d+$/.test(host) ? target.href : '';
    } catch { return ''; }
  }
  function composer(controller) {
    const conversation = controller.root.closest('[data-conversation-scroll]');
    if (!conversation || !conversation.isConnected || conversation.closest('[hidden],[aria-hidden="true"],[inert]')) return null;
    // Current shipped DSH binds Lexical to a contenteditable div. Older builds
    // use textarea; both are explicit composer contracts, never global guesses.
    const candidates = [...conversation.querySelectorAll('[data-composer-card] textarea[data-phase], [data-composer-card] [data-composer-input][role="textbox"]')].filter((input) =>
      input.closest('[data-conversation-scroll]') === conversation && !input.closest('[hidden],[aria-hidden="true"],[inert]') && input.getClientRects().length > 0);
    if (candidates.length !== 1) return null;
    const input = candidates[0];
    const textarea = input.tagName === 'TEXTAREA';
    const editable = input.getAttribute('contenteditable')?.toLowerCase();
    if ((!textarea && !['true', 'plaintext-only'].includes(editable)) || input.disabled || input.readOnly ||
        input.getAttribute('aria-disabled') === 'true' || input.getAttribute('aria-readonly') === 'true' ||
        ['inert', 'submitting', 'adjudicating'].includes(input.dataset.phase)) return null;
    const sessionRoot = conversation.closest('[data-conversation-session]');
    return { conversation, input, card: input.closest('[data-composer-card]'), sessionRoot, sessionId: sessionRoot?.getAttribute('data-conversation-session') ?? null };
  }
  function attachment(card, name) {
    return [...card.querySelectorAll('[role="group"] img[alt]')].find((image) => image.alt === name);
  }
  async function readImage(response, signal) {
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!media.has(type)) throw new Error('返回的图片格式不受支持，未加入输入框');
    const limit = Math.min(200 * 1024 * 1024, Number(options.maxReferenceBytes) || 20 * 1024 * 1024);
    const declared = Number(response.headers.get('content-length'));
    if (declared > limit) throw new Error('图片超过引用大小限制，未加入输入框');
    const chunks = []; let size = 0;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      try {
        while (true) {
          if (signal.aborted) throw new Error('引用已取消');
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength;
          if (size > limit) { await reader.cancel(); throw new Error('图片超过引用大小限制，未加入输入框'); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
    } else {
      const bytes = await response.arrayBuffer(); size = bytes.byteLength;
      if (size > limit) throw new Error('图片超过引用大小限制，未加入输入框');
      chunks.push(bytes);
    }
    if (!size) throw new Error('图片内容为空，未加入输入框');
    return { chunks, type };
  }
  function createButton(item, controller, feedback) {
    const target = endpoint();
    const notify = (message) => services.notify(controller, feedback, message);
    const button = services.button('引用', 'reference', async () => {
      const source = controller.items.find((candidate) => candidate.url === item.url);
      if (!source?.image?.isConnected) { notify('图片已更新，请重新选择要引用的图片'); return; }
      const sourceImage = source.image;
      const initial = composer(controller);
      if (!initial) { notify('未找到可用的当前会话输入框，请回到原会话后重试'); return; }
      if (pending.has(initial.input)) { notify('正在引用图片，请稍候再添加'); return; }
      const fileName = new URL(item.url).pathname.split('/').pop();
      const name = '引用-' + fileName;
      if (attachment(initial.card, name)) {
        services.closePreview(controller); initial.input.focus({ preventScroll: true });
        initial.card.scrollIntoView?.({ block: 'nearest' });
        notify('这张图片已在输入框中，可直接输入修改要求'); return;
      }
      pending.add(initial.input); button.disabled = true;
      button.replaceChildren(services.icon('reference'), document.createTextNode('引用中…'));
      const request = new AbortController();
      const cancel = () => request.abort();
      services.signal.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(cancel, 12000);
      const href = location.href, nav = navigation;
      const anchor = controller.root.closest('[data-chat-anchor-key]');
      const anchorKey = anchor?.getAttribute('data-chat-anchor-key');
      const stillCurrent = () => {
        let currentFilename;
        try { currentFilename = new URL(sourceImage.src).pathname.split('/').pop(); } catch { return false; }
        if (services.isDisposed() || request.signal.aborted || !controller.root.isConnected || !sourceImage.isConnected || !controller.root.contains(sourceImage) ||
            currentFilename !== fileName || location.href !== href || navigation !== nav ||
            controller.root.closest('[data-conversation-scroll]') !== initial.conversation ||
            (anchor && (!anchor.isConnected || anchor.getAttribute('data-chat-anchor-key') !== anchorKey))) return false;
        const now = composer(controller);
        return !!now && now.input === initial.input && now.card === initial.card && now.sessionRoot === initial.sessionRoot && now.sessionId === initial.sessionId;
      };
      let confirmObserver; let confirmTimer;
      try {
        const response = await fetch(target, {
          method: 'POST', credentials: 'same-origin', signal: request.signal,
          headers: { 'content-type': 'application/json', 'x-dsh-gpt-images-token': options.referenceToken },
          body: JSON.stringify({ filename: fileName }),
        });
        if (!response.ok) {
          let message = '图片读取失败，请刷新页面或检查缓存后重试';
          try { const body = await response.json(); if (typeof body.message === 'string') message = body.message.slice(0, 160); } catch { /* Generic error. */ }
          throw new Error(message);
        }
        const image = await readImage(response, request.signal);
        if (!stillCurrent()) throw new Error('会话或输入状态已改变，未引用图片，请回到原会话重试');
        if (attachment(initial.card, name)) { notify('这张图片已在输入框中'); return; }
        const file = new File(image.chunks, name, { type: image.type, lastModified: Date.now() });
        const transfer = new DataTransfer(); transfer.items.add(file);
        const paste = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer });
        if (!paste.clipboardData || paste.clipboardData.items.length !== 1) throw new Error('当前客户端不支持图片引用，请手动添加原图');
        // Only a real attachment rail entry counts as success. preventDefault by
        // itself merely says the paste handler ran; it may have rejected a limit.
        const accepted = new Promise((resolve, reject) => {
          const check = () => {
            if (!stillCurrent()) { reject(new Error('会话或输入状态已改变，请检查原会话的附件')); return; }
            if (attachment(initial.card, name)) resolve();
          };
          confirmObserver = new MutationObserver(check);
          confirmObserver.observe(initial.conversation, { subtree: true, childList: true, attributes: true, attributeFilter: ['alt', 'disabled', 'readonly', 'contenteditable', 'aria-disabled', 'aria-readonly', 'data-phase', 'data-conversation-session'] });
          confirmTimer = setTimeout(() => reject(new Error('输入框未接收图片，请检查附件数量、大小或当前模型支持')), 2500);
          request.signal.addEventListener('abort', () => reject(new Error('引用已取消')), { once: true });
          services.closePreview(controller);
          if (!stillCurrent()) { reject(new Error('会话已切换，未引用图片')); return; }
          initial.input.focus({ preventScroll: true });
          const consumed = !initial.input.dispatchEvent(paste);
          if (!consumed) { reject(new Error('当前输入框不支持图片粘贴，未引用图片')); return; }
          check();
        });
        await accepted;
        initial.input.focus({ preventScroll: true });
        initial.card.scrollIntoView?.({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
        notify('已引用到输入框，输入修改要求后再发送');
      } catch (error) {
        if (!services.isDisposed()) notify(error?.message || '引用失败，未发送消息，请刷新后重试');
      } finally {
        confirmObserver?.disconnect(); clearTimeout(confirmTimer); clearTimeout(timer);
        services.signal.removeEventListener('abort', cancel);
        pending.delete(initial.input);
        button.disabled = !target;
        button.replaceChildren(services.icon('reference'), document.createTextNode('引用'));
      }
    });
    button.title = '将这张图片作为附件加入当前会话输入框，不会自动发送';
    if (!target || typeof DataTransfer !== 'function' || typeof ClipboardEvent !== 'function') {
      button.disabled = true; button.title = '请更新并重载插件，在支持图片附件的客户端中使用引用';
    }
    return button;
  }
  return { createButton };
}
