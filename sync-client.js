/* ЕГЭ-100 · Облачная синхронизация через GitHub Gist + PWA Service Worker */
(function (global) {
  'use strict';

  const CFG_KEY = 'ege100-gh-sync-cfg';
  const PREF_TS_KEY = 'ege100-pref-ts';
  const GIST_FILENAME = 'ege100-progress.json';
  const GIST_DESC = 'ЕГЭ-100 — синхронизация прогресса обучения';
  const SYNC_EXACT = new Set([
    'ege100-topic-order',
    'ege100-hidden-textbooks',
    'tr-removed-packs',
  ]);

  function getPrefTs() {
    const m = lsGet(PREF_TS_KEY, {});
    return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
  }

  function touchPref(key) {
    if (!SYNC_EXACT.has(key)) return;
    const m = getPrefTs();
    m[key] = Date.now();
    lsSet(PREF_TS_KEY, m);
  }

  function isSyncKey(k) {
    return (
      SYNC_EXACT.has(k) ||
      k.startsWith('ege100:kon:') ||
      k.startsWith('tr-state-')
    );
  }

  function lsGet(k, def) {
    try {
      const v = localStorage.getItem(k);
      return v ? JSON.parse(v) : def;
    } catch (e) {
      return def;
    }
  }

  function lsSet(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch (e) {}
  }

  function lsDel(k) {
    try {
      localStorage.removeItem(k);
    } catch (e) {}
  }

  function getConfig() {
    const c = lsGet(CFG_KEY, null);
    if (!c || typeof c !== 'object') return { token: '', gistId: '', siteUrl: '' };
    return {
      token: String(c.token || '').trim(),
      gistId: String(c.gistId || '').trim(),
      siteUrl: String(c.siteUrl || '').trim(),
    };
  }

  function setConfig(patch) {
    const cur = getConfig();
    const next = Object.assign(cur, patch || {});
    lsSet(CFG_KEY, next);
    return next;
  }

  function clearConfig() {
    lsDel(CFG_KEY);
  }

  function collectLocalData() {
    const out = {};
    try {
      Object.keys(localStorage).forEach((k) => {
        if (isSyncKey(k)) {
          const v = lsGet(k, null);
          if (v !== null) out[k] = v;
        }
      });
    } catch (e) {}
    return out;
  }

  function applyLocalData(data) {
    if (!data || typeof data !== 'object') return;
    Object.keys(data).forEach((k) => {
      if (isSyncKey(k)) lsSet(k, data[k]);
    });
  }

  /* ===================== Умное слияние прогресса ===================== */
  function mergeKonState(a, b) {
    const da = a && typeof a === 'object' ? a : {};
    const db = b && typeof b === 'object' ? b : {};
    const out = Object.assign({}, da);
    Object.keys(db).forEach((k) => {
      if (k !== 'completed') out[k] = db[k];
    });
    const ca = da.completed && typeof da.completed === 'object' ? da.completed : {};
    const cb = db.completed && typeof db.completed === 'object' ? db.completed : {};
    const mergedC = {};
    Object.keys(ca).forEach((k) => { if (ca[k]) mergedC[k] = true; });
    Object.keys(cb).forEach((k) => { if (cb[k]) mergedC[k] = true; });
    out.completed = mergedC;
    return out;
  }

  function trLatestTs(st) {
    let ts = 0;
    ['sk', 'facts'].forEach((bucket) => {
      const d = st && st[bucket];
      if (d && typeof d === 'object') {
        Object.values(d).forEach((rec) => {
          if (rec && typeof rec.last === 'number' && rec.last > ts) ts = rec.last;
        });
      }
    });
    if (st && Array.isArray(st.log)) {
      st.log.forEach((item) => {
        if (item && typeof item.t === 'number' && item.t > ts) ts = item.t;
      });
    }
    return ts;
  }

  function mergeTrainerState(a, b) {
    const da = a && typeof a === 'object' ? a : null;
    const db = b && typeof b === 'object' ? b : null;
    if (!da || !Object.keys(da).length) return Object.assign({}, db || {});
    if (!db || !Object.keys(db).length) return Object.assign({}, da);

    const out = {};

    // sk
    const ska = da.sk && typeof da.sk === 'object' ? da.sk : {};
    const skb = db.sk && typeof db.sk === 'object' ? db.sk : {};
    const skm = {};
    new Set([...Object.keys(ska), ...Object.keys(skb)]).forEach((k) => {
      const ra = ska[k], rb = skb[k];
      if (!ra || typeof ra !== 'object') skm[k] = rb;
      else if (!rb || typeof rb !== 'object') skm[k] = ra;
      else {
        const la = Number(ra.last || 0), lb = Number(rb.last || 0);
        const na = Number(ra.n || 0), nb = Number(rb.n || 0);
        skm[k] = lb > la || (lb === la && nb >= na) ? rb : ra;
      }
    });
    out.sk = skm;

    // facts
    const fa = da.facts && typeof da.facts === 'object' ? da.facts : {};
    const fb = db.facts && typeof db.facts === 'object' ? db.facts : {};
    const fm = {};
    new Set([...Object.keys(fa), ...Object.keys(fb)]).forEach((k) => {
      const ra = fa[k], rb = fb[k];
      if (!ra || typeof ra !== 'object') fm[k] = rb;
      else if (!rb || typeof rb !== 'object') fm[k] = ra;
      else {
        const la = Number(ra.last || 0), lb = Number(rb.last || 0);
        const ca = Number(ra.ok || 0) + Number(ra.bad || 0);
        const cb = Number(rb.ok || 0) + Number(rb.bad || 0);
        fm[k] = lb > la || (lb === la && cb >= ca) ? rb : ra;
      }
    });
    out.facts = fm;

    // learned
    const la = da.learned && typeof da.learned === 'object' ? da.learned : {};
    const lb = db.learned && typeof db.learned === 'object' ? db.learned : {};
    const learned = {};
    Object.keys(la).forEach((k) => { if (la[k]) learned[k] = la[k]; });
    Object.keys(lb).forEach((k) => { if (lb[k]) learned[k] = lb[k]; });
    out.learned = learned;

    // fade & days
    ['fade', 'days'].forEach((field) => {
      const xa = da[field] && typeof da[field] === 'object' ? da[field] : {};
      const xb = db[field] && typeof db[field] === 'object' ? db[field] : {};
      const xm = {};
      new Set([...Object.keys(xa), ...Object.keys(xb)]).forEach((k) => {
        const va = xa[k], vb = xb[k];
        if (typeof va === 'number' && typeof vb === 'number') xm[k] = Math.max(va, vb);
        else xm[k] = vb != null ? vb : va;
      });
      out[field] = xm;
    });

    // cal
    const ca = da.cal && typeof da.cal === 'object' ? da.cal : {};
    const cb = db.cal && typeof db.cal === 'object' ? db.cal : {};
    const cm = {};
    ['sure', 'maybe', 'guess'].forEach((k) => {
      const pa = Array.isArray(ca[k]) && ca[k].length === 2 ? ca[k] : [0, 0];
      const pb = Array.isArray(cb[k]) && cb[k].length === 2 ? cb[k] : [0, 0];
      cm[k] = pb[1] > pa[1] || (pb[1] === pa[1] && pb[0] >= pa[0]) ? pb : pa;
    });
    out.cal = cm;

    // log
    const loga = Array.isArray(da.log) ? da.log : [];
    const logb = Array.isArray(db.log) ? db.log : [];
    const seen = new Set();
    const mergedLog = [];
    loga.concat(logb).forEach((item) => {
      const sig = JSON.stringify(item);
      if (!seen.has(sig)) {
        seen.add(sig);
        mergedLog.push(item);
      }
    });
    mergedLog.sort((x, y) => Number((x && x.t) || 0) - Number((y && y.t) || 0));
    out.log = mergedLog.slice(-500);

    // red
    const tsa = trLatestTs(da), tsb = trLatestTs(db);
    const ra = Array.isArray(da.red) ? da.red : [];
    const rb = Array.isArray(db.red) ? db.red : [];
    if (tsb > tsa) out.red = rb;
    else if (tsa > tsb) out.red = ra;
    else {
      const seenR = new Set();
      out.red = [];
      ra.concat(rb).forEach((item) => {
        const sig = JSON.stringify(item);
        if (!seenR.has(sig)) { seenR.add(sig); out.red.push(item); }
      });
    }

    return out;
  }

  function mergeProgress(remoteData, localData, resetKeys, remotePrefTs, localPrefTs) {
    const out = {};
    const rTs = remotePrefTs && typeof remotePrefTs === 'object' ? remotePrefTs : {};
    const lTs = localPrefTs && typeof localPrefTs === 'object' ? localPrefTs : {};
    if (remoteData && typeof remoteData === 'object') {
      Object.keys(remoteData).forEach((k) => {
        if (isSyncKey(k)) out[k] = remoteData[k];
      });
    }
    (resetKeys || []).forEach((rk) => {
      if (typeof rk === 'string') delete out[rk];
    });
    if (localData && typeof localData === 'object') {
      Object.keys(localData).forEach((k) => {
        if (!isSyncKey(k) || localData[k] == null) return;
        if (k.startsWith('ege100:kon:')) out[k] = mergeKonState(out[k], localData[k]);
        else if (k.startsWith('tr-state-')) out[k] = mergeTrainerState(out[k], localData[k]);
        else {
          const lt = Number(lTs[k] || 0);
          const rt = Number(rTs[k] || 0);
          if (!(k in out) || lt >= rt) out[k] = localData[k];
        }
      });
    }
    return out;
  }

  /* ===================== GitHub Gist API ===================== */
  function ghHeaders(token) {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    };
  }

  async function findOrCreateGist(token) {
    // 1. Ищем уже существующий Gist с файлом ege100-progress.json
    const listResp = await fetch('https://api.github.com/gists?per_page=100', {
      headers: ghHeaders(token),
      cache: 'no-store',
    });
    if (!listResp.ok) {
      if (listResp.status === 401) throw new Error('Неверный GitHub токен (401).');
      throw new Error('Ошибка GitHub API (' + listResp.status + ')');
    }
    const gists = await listResp.json();
    const existing = Array.isArray(gists)
      ? gists.find((g) => g && g.files && g.files[GIST_FILENAME])
      : null;
    if (existing && existing.id) return existing.id;

    // 2. Если нет — создаём приватный (secret) Gist
    const initial = {
      app: 'ege100-sync',
      version: 1,
      updated_at: new Date().toISOString(),
      data: collectLocalData(),
    };
    const createResp = await fetch('https://api.github.com/gists', {
      method: 'POST',
      headers: ghHeaders(token),
      body: JSON.stringify({
        description: GIST_DESC,
        public: false,
        files: {
          [GIST_FILENAME]: { content: JSON.stringify(initial, null, 2) },
        },
      }),
    });
    if (!createResp.ok) {
      throw new Error('Не удалось создать Gist (' + createResp.status + '). Проверьте право "gist" у токена.');
    }
    const created = await createResp.json();
    return created.id;
  }

  async function connectGitHub(token, siteUrl) {
    const cleanToken = String(token || '').trim();
    if (!cleanToken) throw new Error('Введите GitHub токен.');
    const gistId = await findOrCreateGist(cleanToken);
    setConfig({
      token: cleanToken,
      gistId: gistId,
      siteUrl: String(siteUrl || '').trim(),
    });
    return { gistId };
  }

  async function syncGist(resetKeys) {
    const cfg = getConfig();
    if (!cfg.token) return { ok: false, skipped: true, reason: 'no_token' };

    let gistId = cfg.gistId;
    if (!gistId) {
      gistId = await findOrCreateGist(cfg.token);
      setConfig({ gistId });
    }

    // 1. Читаем актуальный Gist
    const getResp = await fetch('https://api.github.com/gists/' + encodeURIComponent(gistId), {
      headers: ghHeaders(cfg.token),
      cache: 'no-store',
    });
    if (!getResp.ok) {
      throw new Error('Ошибка чтения Gist (' + getResp.status + ')');
    }
    const gist = await getResp.json();
    const fileObj = gist && gist.files && gist.files[GIST_FILENAME];
    let remoteData = {};
    let remotePrefTs = {};
    if (fileObj && fileObj.content) {
      try {
        const parsed = JSON.parse(fileObj.content);
        remoteData = (parsed && parsed.data && typeof parsed.data === 'object') ? parsed.data : {};
        remotePrefTs = (parsed && parsed.pref_ts && typeof parsed.pref_ts === 'object') ? parsed.pref_ts : {};
      } catch (e) {}
    }

    // 2. Умно объединяем
    const localData = collectLocalData();
    const localPrefTs = getPrefTs();
    const merged = mergeProgress(remoteData, localData, resetKeys || [], remotePrefTs, localPrefTs);
    const mergedPrefTs = {};
    SYNC_EXACT.forEach((k) => {
      const t = Math.max(Number(remotePrefTs[k] || 0), Number(localPrefTs[k] || 0));
      if (t > 0) mergedPrefTs[k] = t;
    });

    // 3. Сохраняем объединённое состояние в Gist
    const payload = {
      app: 'ege100-sync',
      version: 1,
      updated_at: new Date().toISOString(),
      pref_ts: mergedPrefTs,
      data: merged,
    };
    const patchResp = await fetch('https://api.github.com/gists/' + encodeURIComponent(gistId), {
      method: 'PATCH',
      headers: ghHeaders(cfg.token),
      body: JSON.stringify({
        files: {
          [GIST_FILENAME]: { content: JSON.stringify(payload, null, 2) },
        },
      }),
    });
    if (!patchResp.ok) {
      throw new Error('Ошибка записи в Gist (' + patchResp.status + ')');
    }

    // 4. Применяем в localStorage
    applyLocalData(merged);
    lsSet(PREF_TS_KEY, mergedPrefTs);
    return { ok: true, gistId, updatedAt: payload.updated_at };
  }

  /* ===================== PWA Service Worker ===================== */
  let _swRegPromise = null;
  function registerSW(swRelPath) {
    if (!('serviceWorker' in navigator)) return Promise.resolve(null);
    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      return Promise.resolve(null);
    }
    if (!_swRegPromise) {
      _swRegPromise = navigator.serviceWorker
        .register(swRelPath || './sw.js')
        .catch(() => null);
    }
    return _swRegPromise;
  }

  async function syncContentViaSW(swRelPath) {
    const reg = await registerSW(swRelPath);
    if (!reg) return { ok: false, skipped: true };
    try {
      await reg.update();
    } catch (e) {}
    const worker = reg.active || reg.waiting || reg.installing;
    if (!worker) return { ok: false, skipped: true };

    return new Promise((resolve) => {
      const ch = new MessageChannel();
      const timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), 45000);
      ch.port1.onmessage = (ev) => {
        clearTimeout(timer);
        resolve(ev.data || { ok: false });
      };
      try {
        worker.postMessage({ type: 'SYNC_CONTENT' }, [ch.port2]);
      } catch (e) {
        clearTimeout(timer);
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  /* ===================== Ссылка быстрой настройки для телефона ===================== */
  function buildPhoneSetupLink(baseUrl) {
    const cfg = getConfig();
    if (!cfg.token || !cfg.gistId) return '';
    const target = String(baseUrl || cfg.siteUrl || (location.origin + location.pathname)).trim();
    if (!target) return '';
    const raw = JSON.stringify({ t: cfg.token, g: cfg.gistId, u: target });
    const b64 = btoa(unescape(encodeURIComponent(raw)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const cleanTarget = target.split('#')[0];
    return cleanTarget + '#ghsync=' + b64;
  }

  function importConfigFromHash() {
    const hash = String(location.hash || '');
    const m = hash.match(/ghsync=([A-Za-z0-9\-_]+)/);
    if (!m) return false;
    try {
      let b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const obj = JSON.parse(decodeURIComponent(escape(atob(b64))));
      if (obj && obj.t) {
        setConfig({
          token: obj.t,
          gistId: obj.g || '',
          siteUrl: obj.u || '',
        });
        // Убираем токен из адресной строки сразу после сохранения
        if (history && history.replaceState) {
          history.replaceState(null, '', location.pathname + location.search);
        }
        return true;
      }
    } catch (e) {}
    return false;
  }

  /* ===================== Единая функция синхронизации ===================== */
  async function syncAll(opts) {
    const {
      updateContent = true,
      resetKeys = [],
      swPath = './sw.js',
    } = opts || {};

    const result = { ok: false, progress: null, content: null, errors: [] };

    // 1. Синхронизация прогресса через GitHub Gist (если подключён токен)
    const cfg = getConfig();
    if (cfg.token) {
      try {
        result.progress = await syncGist(resetKeys);
      } catch (e) {
        result.errors.push(String(e && e.message || e));
      }
    }

    // 2. Обновление контента (учебников/тренажёров) через Service Worker (если HTTPS / GitHub Pages)
    if (updateContent) {
      try {
        result.content = await syncContentViaSW(swPath);
      } catch (e) {
        result.errors.push(String(e && e.message || e));
      }
    }

    result.ok = result.errors.length === 0;
    return result;
  }

  global.EGE100Sync = {
    getConfig,
    setConfig,
    clearConfig,
    isConfigured: () => Boolean(getConfig().token),
    connectGitHub,
    syncGist,
    syncContentViaSW,
    syncAll,
    registerSW,
    buildPhoneSetupLink,
    importConfigFromHash,
    mergeProgress,
    touchPref,
  };
})(window);
