/* Prooloog adapter.
   The dashboard page was built to run inside Claude, where the platform hands it window.claude:
   a document store, the current user, Claude itself. On our own server this file plays that part:
   it signs the visitor in (Telegram Mini App or a one-time link from the bot) and backs the same
   calls with the server API. The page code stays the same in both places. */
(function () {
  'use strict';
  var KEY = 'prooloog.session';
  var tg = window.Telegram && window.Telegram.WebApp;
  var inTg = !!(tg && tg.initData);
  var token = '', me = null, es = null;
  var clientId = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  var cache = {}, versions = {}, loaded = {}, loading = {}, collSubs = {}, docSubs = {}, pending = {}, dirty = {};

  function keep(v) { try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch (e) { /* storage is optional */ } }
  function kept() { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function merge(a, b) { Object.keys(b).forEach(function (k) { if (isObj(b[k]) && isObj(a[k])) merge(a[k], b[k]); else a[k] = b[k]; }); return a; }
  function fail(code, status) { var e = new Error(code); e.code = code; e.status = status || 0; return e; }

  function api(method, path, body, raw) {
    var h = { 'X-Client': clientId };
    if (token) h.Authorization = 'Bearer ' + token;
    var opt = { method: method, headers: h };
    if (raw) { opt.body = raw.body; h['Content-Type'] = raw.type; }
    else if (body !== undefined) { opt.body = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
    return fetch('/api' + path, opt).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        if (!r.ok) throw fail((j && j.error) || 'http_' + r.status, r.status);
        return j;
      });
    }, function () { throw fail('network'); });
  }

  // Inside Telegram a t.me link (the invite, «add the bot to a chat») opens in Telegram itself, not in a browser tab.
  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href^="https://t.me/"]') : null;
    if (!a || !inTg || typeof tg.openTelegramLink !== 'function') return;
    try { tg.openTelegramLink(a.href); ev.preventDefault(); } catch (e) { /* the link opens the usual way */ }
  });

  /* ---------- sign-in ---------- */
  function signIn() {
    function ok(j) { token = j.token; keep(token); me = j; return j; }
    function fromStore() {
      token = kept();
      if (!token) return Promise.reject(fail('no_session'));
      return api('GET', '/me').then(function (j) { me = j; return j; }, function (e) { if (e.status === 401 || e.status === 403) { keep(''); token = ''; } throw e; });
    }
    var m = /[?&]k=([A-Za-z0-9_-]{16,80})/.exec(location.search || '');
    if (m) {
      // A one-time link from the bot: trade it for a session and take it out of the address bar.
      try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) { /* cosmetic */ }
      return api('POST', '/auth/code', { code: m[1] }).then(ok, fromStore);
    }
    if (inTg) return api('POST', '/auth/telegram', { initData: tg.initData }).then(ok);
    return fromStore();
  }

  function gate(code) {
    var text = {
      no_session: 'Это закрытый дэшборд. Открой его из Telegram-бота или отправь боту команду /login: он пришлёт ссылку для входа в браузере.',
      no_access: 'У тебя пока нет доступа. Попроси владельца пригласить тебя.',
      unauthorized: 'Не получилось подтвердить вход. Закрой это окно и открой дэшборд из бота ещё раз.',
      code_expired: 'Ссылка для входа уже использована или устарела. Отправь боту /login и открой новую.',
      network: 'Сервер не отвечает. После простоя он просыпается около минуты: обнови страницу чуть позже.'
    }[code] || 'Не получилось открыть дэшборд. Обнови страницу чуть позже.';
    function show() {
      var d = document.createElement('div');
      d.id = 'px-gate';
      d.setAttribute('role', 'alert');
      d.style.cssText = 'position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:24px;background:var(--bg,#f4f4f7);color:var(--ink,#16181d);font:16px/1.5 system-ui,sans-serif';
      var b = document.createElement('div');
      b.style.cssText = 'max-width:440px;display:flex;flex-direction:column;gap:14px;align-items:flex-start';
      var h = document.createElement('h1'); h.textContent = (me && me.app && me.app.name) || document.title || 'Prooloog'; h.style.cssText = 'font:600 26px/1.2 var(--display,system-ui);margin:0';
      var p = document.createElement('p'); p.textContent = text; p.style.margin = '0';
      var a = document.createElement('button'); a.type = 'button'; a.textContent = 'Обновить'; a.className = 'btn';
      a.style.cssText = 'padding:9px 16px;border-radius:9px;border:1px solid currentColor;background:none;color:inherit;font:inherit;cursor:pointer';
      a.onclick = function () { location.reload(); };
      b.appendChild(h); b.appendChild(p); b.appendChild(a); d.appendChild(b); document.body.appendChild(d);
    }
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
  }

  /* ---------- document store ---------- */
  function mkDoc(id, data) { return { id: id, exists: data !== undefined, data: function () { return clone(data); } }; }
  function snapOf(name) {
    var o = cache[name] || {};
    var docs = Object.keys(o).sort().map(function (id) { return mkDoc(id, o[id]); });
    return { docs: docs, size: docs.length, empty: !docs.length, forEach: function (f) { docs.forEach(f); } };
  }
  function emit(name) {
    var s = null;
    (collSubs[name] || []).slice().forEach(function (cb) { try { cb(s || (s = snapOf(name))); } catch (e) { console.error(e); } });
    (docSubs[name] || []).slice().forEach(function (x) { try { x.cb(mkDoc(x.id, (cache[name] || {})[x.id])); } catch (e) { console.error(e); } });
  }
  function load(name) {
    if (loading[name]) return loading[name];
    // Money, contacts and client messages belong to the owner: other roles do not even ask.
    // A coordinator gets some of them, for their projects (me.managed).
    if (me && me.role !== 'owner' && (me.ownerOnly || []).indexOf(name) >= 0 && !(me.role === 'manager' && (me.managed || []).indexOf(name) >= 0)) return Promise.reject(fail('forbidden', 403));
    loading[name] = api('GET', '/db/' + name).then(function (j) {
      var o = {}, v = {};
      (j.docs || []).forEach(function (d) { o[d.id] = d.data; v[d.id] = d.version; });
      cache[name] = o; versions[name] = v; loaded[name] = true; delete loading[name];
      emit(name);
    }, function (e) { delete loading[name]; throw e; });
    return loading[name];
  }
  function refetch(name) { if (loaded[name]) load(name).catch(function () { /* the next event or reconnect retries */ }); }
  function listen(name, list, item, onErr) {
    list.push(item);
    if (loaded[name]) setTimeout(function () { if (list.indexOf(item) >= 0) emit(name); }, 0);
    else load(name).catch(function (e) { if (onErr) try { onErr(e); } catch (x) { console.error(x); } });
    return function () { var i = list.indexOf(item); if (i >= 0) list.splice(i, 1); };
  }
  function write(name, id, kind, data) {
    var key = name + '/' + id;
    if (!loaded[name]) cache[name] = cache[name] || {};
    var had = Object.prototype.hasOwnProperty.call(cache[name], id);
    if (kind === 'update' && !had && loaded[name]) return Promise.reject(fail('not_found', 404));
    if (kind === 'set') cache[name][id] = clone(data);
    else if (kind === 'update') cache[name][id] = merge(clone(cache[name][id] || {}), clone(data));
    else delete cache[name][id];
    pending[key] = (pending[key] || 0) + 1;
    emit(name);
    var path = '/db/' + name + '/' + encodeURIComponent(id);
    var call = kind === 'set' ? api('PUT', path, { data: data }) : kind === 'update' ? api('PATCH', path, { data: data }) : api('DELETE', path);
    function settle() { if (--pending[key] <= 0) delete pending[key]; }
    return call.then(function (j) {
      settle();
      if (j && j.version) { versions[name] = versions[name] || {}; versions[name][id] = j.version; }
      // Someone else changed this document while our write was on its way: take the server's copy.
      if (!pending[key] && dirty[key]) { delete dirty[key]; refetch(name); }
    }, function (e) {
      settle(); delete dirty[key];
      refetch(name);          // roll the screen back to what the server really has
      throw e;
    });
  }
  function docRef(name, id) {
    return {
      id: id, path: name + '/' + id,
      set: function (d) { return write(name, id, 'set', d); },
      update: function (d) { return write(name, id, 'update', d); },
      delete: function () { return write(name, id, 'delete'); },
      onSnapshot: function (cb, onErr) { docSubs[name] = docSubs[name] || []; return listen(name, docSubs[name], { id: id, cb: cb }, onErr); }
    };
  }
  var dbNs = {
    collection: function (name) {
      return {
        path: name,
        doc: function (id) { return docRef(name, id); },
        onSnapshot: function (cb, onErr) { collSubs[name] = collSubs[name] || []; return listen(name, collSubs[name], cb, onErr); }
      };
    },
    doc: function (p) { var a = String(p).split('/'); return docRef(a[0], a[1]); }
  };

  function live() {
    if (!window.EventSource) return;
    var first = true;
    es = new EventSource('/api/stream?t=' + encodeURIComponent(token));
    es.onopen = function () { if (!first) Object.keys(loaded).forEach(refetch); first = false; };
    es.addEventListener('doc', function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m || !loaded[m.coll] || m.src === clientId) return;
      var key = m.coll + '/' + m.id;
      if (pending[key]) { dirty[key] = 1; return; }
      if (m.data === null) { delete cache[m.coll][m.id]; delete versions[m.coll][m.id]; }
      else {
        var cur = versions[m.coll][m.id];
        if (cur && m.version && m.version <= cur) return;
        cache[m.coll][m.id] = m.data; versions[m.coll][m.id] = m.version;
      }
      emit(m.coll);
    });
    // Everything changed, or this person's access did: check the access first, then load again.
    es.addEventListener('reload', function () {
      api('GET', '/me').then(function (j) {
        // another level, or all projects instead of some: the page is built differently, so it starts again
        var turned = !me || j.role !== me.role || Array.isArray(j.projects) !== Array.isArray(me.projects) || (j.role === 'manager' && String(j.projects) !== String(me.projects));
        me = j;
        if (turned) { try { es.close(); } catch (x) { /* already closed */ } location.reload(); return; }
        Object.keys(loaded).forEach(refetch);
      }, function (e) {
        if (e.status === 401 || e.status === 403) { try { es.close(); } catch (x) { /* already closed */ } gate('no_access'); }
        else Object.keys(loaded).forEach(refetch);
      });
    });
  }

  /* ---------- Claude answers, when the server has a key ---------- */
  function sample(input, opts) {
    opts = opts || {};
    return fetch('/api/ai', {
      method: 'POST', signal: opts.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ input: input })
    }).then(function (r) {
      if (!r.ok || !r.body) return r.json().catch(function () { return {}; }).then(function (j) { throw fail((j && j.error) || 'upstream', r.status); });
      var reader = r.body.getReader(), dec = new TextDecoder(), buf = '', text = '', truncated = false;
      function eat(line) {
        if (!line.trim()) return;
        var m; try { m = JSON.parse(line); } catch (e) { return; }
        if (m.d) { text += m.d; if (opts.onText) { try { opts.onText({ text: text, delta: m.d }); } catch (e) { console.error(e); } } }
        else if (m.error) throw fail(m.error);
        else if (m.done) truncated = !!m.truncated;
      }
      function pump() {
        return reader.read().then(function (x) {
          if (x.done) { eat(buf); return; }
          buf += dec.decode(x.value, { stream: true });
          var i;
          while ((i = buf.indexOf('\n')) >= 0) { var l = buf.slice(0, i); buf = buf.slice(i + 1); eat(l); }
          return pump();
        });
      }
      return pump().then(function () {
        if (!text) throw fail('empty_completion');
        return { text: text, truncated: truncated };
      });
    }).catch(function (e) {
      if (e && e.name === 'AbortError') throw fail('cancelled');
      if (e && e.code) throw e;
      throw fail('upstream');
    });
  }

  var filesNs = {
    // true when the server makes a Zoom room of its own for every meeting
    zoom: function () { return !!(me && me.app && me.app.zoom); },
    upload: function (blob, meta) {
      return api('POST', '/files', undefined, { body: blob, type: (meta && meta.type) || blob.type || 'image/jpeg' });
    },
    tgUrl: function (fileId) { return '/api/tg/file/' + encodeURIComponent(fileId) + '?t=' + encodeURIComponent(token); },
    // The bot's username, for links that lead people to the bot.
    bot: function () { return (me && me.app && me.app.bot) || ''; },
    // Replaces or merges all data with a copy made by «Скопировать все данные».
    importData: function (copy, mode) { return api('POST', '/import', { app: 'prooloog', docs: copy.docs, mode: mode === 'replace' ? 'replace' : 'merge' }); }
  };
  // «Скачать файлом». Inside Telegram a page cannot save files reliably, so the bot sends the copy to the chat.
  var downloadsNs = {
    save: function (req) {
      if (inTg && me && me.role === 'owner') {
        return api('POST', '/backup/send').then(function () { return { status: 'saved', note: 'Файл с копией отправлен тебе в чат с ботом.' }; });
      }
      return new Promise(function (resolve, reject) {
        try {
          var blob = req.data instanceof Blob ? req.data : new Blob([req.data], { type: 'application/json' });
          var url = URL.createObjectURL(blob), a = document.createElement('a');
          a.href = url; a.download = String(req.filename || 'prooloog-data.json'); a.style.display = 'none';
          document.body.appendChild(a); a.click();
          setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 4000);
          resolve({ status: 'saved' });
        } catch (e) { reject(fail('unavailable')); }
      });
    }
  };
  var userNs = {
    can: function () { return Promise.resolve(!!me && me.role !== 'viewer'); },
    isOwner: function () { return Promise.resolve(!!me && me.role === 'owner'); },
    // true for a coordinator: runs the projects they see next to the owner
    manages: function () { return Promise.resolve(!!me && me.role === 'manager'); },
    // true for a member who sees only some of the projects
    scoped: function () { return Promise.resolve(!!me && Array.isArray(me.projects)); }
  };
  // Work chats the bot sits in: write there through the bot, or take the bot out. For the owner only.
  var chatNs = {
    post: function (id, text, buttons) { return api('POST', '/chats/' + encodeURIComponent(id) + '/post', { text: text, buttons: !!buttons }); },
    leave: function (id) { return api('POST', '/chats/' + encodeURIComponent(id) + '/leave'); },
    bot: function () { return (me && me.app && me.app.bot) || ''; },
    readsAll: function () { return !!(me && me.app && me.app.readsAll); }
  };
  // Onboarding of a project: the link for a chat, who filled the form in and what they answered. For the owner only.
  var onboardNs = {
    get: function (pid) { return api('GET', '/onboard/' + encodeURIComponent(pid)); },
    on: function (pid, form) { return api('POST', '/onboard/' + encodeURIComponent(pid), form ? { form: form } : {}); },
    off: function (pid, form) { return api('DELETE', '/onboard/' + encodeURIComponent(pid) + (form ? '?form=' + encodeURIComponent(form) : '')); },
    csv: function (pid, form) { return api('POST', '/onboard/' + encodeURIComponent(pid) + '/csv' + (form ? '?form=' + encodeURIComponent(form) : '')); },
    qr: function (pid) { return api('GET', '/onboard/' + encodeURIComponent(pid) + '/qr'); },
    // «Создать анкету»: a project without a form gets a short one to start from; kind is 'team' or 'invite'
    create: function (pid, kind) { return api('POST', '/onboard/' + encodeURIComponent(pid) + '/form', { kind: kind }); },
    // the address of the form's preview, for a frame inside the dashboard; the session goes in the part of the
    // address that is never sent to a server
    preview: function (pid, form) { return '/preview/' + encodeURIComponent(pid) + (form ? '?form=' + encodeURIComponent(form) : '') + '#t=' + encodeURIComponent(token); },
    // every answer of the project's onboarding as a file. Inside Telegram the bot sends it to the chat; in a browser it is saved.
    file: function (pid, format) {
      var path = '/onboard/' + encodeURIComponent(pid) + '/export';
      if (inTg) return api('POST', path, { format: format, send: true }).then(function (r) { return { status: 'sent', n: r.n }; });
      return api('POST', path, { format: format }).then(function (r) {
        var blob = new Blob([r.text], { type: format === 'json' ? 'application/json' : 'text/csv;charset=utf-8' });
        var url = URL.createObjectURL(blob), a = document.createElement('a');
        a.href = url; a.download = r.filename; a.style.display = 'none';
        document.body.appendChild(a); a.click();
        setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 4000);
        return { status: 'saved', n: r.n, filename: r.filename };
      });
    }
  };
  // Who has access and invite links; for the owner only.
  var shareNs = {
    list: function () { return api('GET', '/share'); },
    create: function (role, projects) { return api('POST', '/share/links', { role: role, projects: projects }); },
    dropLink: function (token) { return api('DELETE', '/share/links/' + encodeURIComponent(token)); },
    dropName: function (username) { return api('DELETE', '/share/names/' + encodeURIComponent(username)); },
    setMember: function (id, role, projects) { return api('PATCH', '/share/members/' + encodeURIComponent(id), { role: role, projects: projects }); },
    dropMember: function (id) { return api('DELETE', '/share/members/' + encodeURIComponent(id)); },
    chat: function (id) { return api('POST', '/share/members/' + encodeURIComponent(id) + '/chat'); }
  };

  /* ---------- start ---------- */
  if (inTg) {
    try {
      tg.ready(); tg.expand();
      var paint = function () { if (tg.colorScheme === 'dark' || tg.colorScheme === 'light') document.documentElement.setAttribute('data-theme', tg.colorScheme); };
      paint();
      if (tg.onEvent) tg.onEvent('themeChanged', paint);
    } catch (e) { /* older Telegram clients */ }
  }
  var session = signIn().then(function (j) { live(); return j; });
  session.catch(function (e) { gate((e && e.code) || 'error'); });
  var never = new Promise(function () {});
  window.claude = {
    use: function (name) {
      return session.then(function () {
        if (name === 'db') return dbNs;
        if (name === 'user') return userNs;
        if (name === 'files') return filesNs;
        if (name === 'downloads') return downloadsNs;
        var lead = !!me && (me.role === 'owner' || me.role === 'manager'); // the owner or a coordinator
        if (name === 'share') return lead ? shareNs : null;
        if (name === 'chat') return lead ? chatNs : null;
        if (name === 'onboard') return lead ? onboardNs : null;
        // the journal of actions is kept by the server, so the page does not write its own
        if (name === 'journal') return { server: true };
        if (name === 'sample') return me.caps && me.caps.ai ? sample : null;
        return null;
      }, function () { return never; });
    }
  };
})();
