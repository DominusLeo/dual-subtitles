// ==UserScript==
// @name         Dual subtitles (EN знизу + UK/RU згори)
// @namespace    art-leo/dual-subs
// @version      2.4.1
// @description  HTML5-плеєри з нативними доріжками і Playerjs (rezka): повні англійські знизу, українські або російські згори.
// @match        *://*/*
// @run-at       document-start
// @grant        none
// @homepageURL  https://github.com/DominusLeo/dual-subtitles
// @supportURL   https://github.com/DominusLeo/dual-subtitles/issues
// @updateURL    https://raw.githubusercontent.com/DominusLeo/dual-subtitles/main/dual-subtitles.user.js
// @downloadURL  https://raw.githubusercontent.com/DominusLeo/dual-subtitles/main/dual-subtitles.user.js
// @license      MIT
// ==/UserScript==
// НЕ додавати @noframes: плеєри живуть в iframe балансерів, скрипт має виконатись саме там.
// @match широкий навмисно: домени балансерів ротуються (api.ortified.ws → api2.ortified.ws → ...).
// На сторінці без <video> з доріжками скрипт нічого не робить.
// Клавіші (усі з Alt): S — вимк/увімк · L — згори+знизу ↔ обидва знизу · = / - — розмір · ↑ / ↓ — висота · 0 — скинути.

(function dualSubs() {
  'use strict';

  // Друга копія в менеджері скриптів або повторна ін'єкція малювала б дубль оверлея.
  // Атрибут на <html>, а не змінна window: копії можуть жити в різних JS-світах.
  // У Firefox на document-start <html> ще може не існувати — тоді лишається прапорець на document.
  const root = document.documentElement;
  if (document.__dualSubs || (root && root.hasAttribute('data-dual-subs'))) {
    if (root) root.setAttribute('data-dual-subs', '1');   // щоб adoptFrames батька бачив: копія тут уже є
    return;
  }
  document.__dualSubs = true;
  if (root) root.setAttribute('data-dual-subs', '1');

  // ── Налаштування ───────────────────────────────────────────────────────────
  const CFG = {
    bottomLang: 'en',
    topLangs: ['uk', 'ru'],        // пріоритет: перша мова, для якої є ПОВНА доріжка
    singleOnTop: true,             // знайшлась лише одна мова → показувати її згори
    bottomSizePct: 4.4,            // розмір шрифту, % висоти відео
    topSizePct: 4.8,
    bottomOffsetPct: 10,           // відступ від низу відео, % висоти (над панеллю керування)
    topOffsetPct: 9,               // відступ від верху відео, % висоти
    minCues: 40,                   // менше реплік → «форсовані» (лише написи в кадрі)
    minRatioToBottom: 0.3,         // верхня доріжка має мати ≥30% реплік нижньої
    sdhRatio: 0.06,                // частка реплік із (ЗВУКАМИ)/[звуками], вище — це SDH
    layout: 'split',               // 'split' — переклад згори, англ. знизу; 'stacked' — обидва знизу, кожен в один рядок
    stacked: {
      topSizePct: 3.6,             // рядок перекладу (верхній у парі)
      bottomSizePct: 3.4,          // англійський рядок (нижній у парі)
      offsetPct: 7,                // відступ пари від низу відео
      gapPct: 0.4,                 // проміжок між рядками
      lineHeight: 1.15,
      minFit: 0.6,                 // рядок не влазить → шрифт меншає до 60%, далі переноситься
    },
    // Усі з Alt. Вибір (layout, розмір, зсув) зберігається в localStorage домену плеєра.
    keys: {
      toggle: 'KeyS',              // вимкнути/увімкнути
      layout: 'KeyL',              // split ↔ stacked
      bigger: 'Equal', smaller: 'Minus',
      up: 'ArrowUp', down: 'ArrowDown',   // зсув нижнього блоку, крок 1% висоти
      reset: 'Digit0',
    },
  };

  // Збережений вибір юзера поверх CFG. Ключ і формат читають лише ці функції.
  const PREFS_KEY = 'dualSubs.prefs';
  const PREFS_DEFAULT = () => ({ layout: CFG.layout, scale: 1, shift: 0 });
  const prefs = PREFS_DEFAULT();
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY)) || {}); } catch (e) { /* sandbox без storage */ }
  const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* sandbox */ } };
  const stacked = () => prefs.layout === 'stacked';

  // ── Класифікація доріжки ───────────────────────────────────────────────────
  // \b у JS не працює з кирилицею, тому кириличні шаблони без нього.
  const LABEL_LANG = [
    ['uk', /укр|україн|украин|\bukr|\bua\b|\buk\b/i],
    ['ru', /рус|росій|\brus|\bru\b/i],
    ['en', /\beng|\ben\b|англ/i],
  ];
  const FORCED_RE = /форс|forced|надпис|\bsigns?\b/i;
  const SDH_LABEL_RE = /\bsdh\b|\bcc\b|hearing|глух/i;
  const SDH_CUE_RE = /[[(][^\])]{2,}[\])]|♪/;

  const langFromLabel = label => {
    for (const [lang, re] of LABEL_LANG) if (re.test(label)) return lang;
    return null;
  };
  const langFromCode = code => {
    const c = (code || '').toLowerCase();
    if (/^(uk|ukr)\b/.test(c)) return 'uk';
    if (/^(ru|rus)\b/.test(c)) return 'ru';
    if (/^(en|eng)\b/.test(c)) return 'en';
    return null;
  };
  const langFromText = text => {
    const lat = (text.match(/[a-z]/gi) || []).length;
    const cyr = (text.match(/[а-яіїєґё]/gi) || []).length;
    if (lat > cyr * 2 && lat > 50) return 'en';
    if (cyr > lat * 2 && cyr > 50) {
      const uk = (text.match(/[іїєґ]/gi) || []).length;
      const ru = (text.match(/[ыэъё]/gi) || []).length;
      return uk > ru ? 'uk' : 'ru';
    }
    return null;
  };

  const cueText = c => (c.text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

  function describe(t) {
    const cues = t.cues ? [...t.cues] : [];
    const sample = cues.slice(0, 200).map(cueText).join('\n');
    const sdhHits = cues.filter(c => SDH_CUE_RE.test(cueText(c))).length;
    return {
      track: t,
      label: t.label,
      lang: langFromLabel(t.label) || langFromCode(t.language) || langFromText(sample),
      cues: cues.length,
      forced: FORCED_RE.test(t.label),
      sdh: SDH_LABEL_RE.test(t.label) || (cues.length > 0 && sdhHits / cues.length > CFG.sdhRatio),
    };
  }

  // .vtt вантажиться лише коли mode != 'disabled'; чекаємо, поки кількість реплік стабілізується.
  async function loadCues(tracks, isStale) {
    tracks.forEach(t => { if (t.mode === 'disabled') t.mode = 'hidden'; });
    let prev = '';
    for (let i = 0; i < 30; i++) {           // до ~9 с
      await new Promise(r => setTimeout(r, 300));
      if (isStale()) return;
      const now = tracks.map(t => (t.cues ? t.cues.length : -1)).join(',');
      if (now === prev && !now.split(',').includes('-1') && !now.split(',').includes('0')) return;
      prev = now;
    }
  }

  // Повна доріжка: не форсована, не SDH (якщо є альтернатива), найбільше реплік.
  function best(infos, lang, minCues) {
    const pool = infos.filter(i => i.lang === lang && !i.forced && i.cues >= minCues);
    pool.sort((a, b) => (a.sdh - b.sdh) || (b.cues - a.cues));
    return pool[0] || null;
  }

  // ── Контролер одного <video> ───────────────────────────────────────────────
  const controllers = new Set();
  const attached = new WeakSet();
  let enabled = true;

  class Controller {
    constructor(video) {
      this.video = video;
      this.bottom = null;
      this.top = null;
      this.token = 0;
      this.enforceLog = [];
      this.timer = null;

      const tl = video.textTracks;
      const schedule = () => this.schedule();
      tl.addEventListener('addtrack', schedule);
      tl.addEventListener('removetrack', schedule);
      tl.addEventListener('change', () => this.enforce());
      video.addEventListener('loadedmetadata', schedule);
      video.addEventListener('emptied', schedule);

      this.box = document.createElement('div');
      this.box.className = 'dual-subs-box';
      this.lineTop = document.createElement('div');
      this.lineBottom = document.createElement('div');
      this.osd = document.createElement('div');
      this.box.append(this.lineTop, this.lineBottom, this.osd);
      this.styleBox();

      this.onCue = () => this.render();
      this.ro = new ResizeObserver(() => this.layout());
      this.ro.observe(video);

      // Firefox не оновлює activeCues для частини доріжок (cue накриває час, activeCues порожній),
      // тому текст рахуємо самі за currentTime. Кадровий колбек — без затримки timeupdate (~250 мс).
      video.addEventListener('timeupdate', this.onCue);
      video.addEventListener('seeked', this.onCue);
      if (typeof video.requestVideoFrameCallback === 'function') {
        const tick = () => {
          if (this.dead) return;
          if (enabled && (this.bottom || this.top)) this.renderText();
          video.requestVideoFrameCallback(tick);
        };
        video.requestVideoFrameCallback(tick);
      }

      this.schedule(0);
    }

    styleBox() {
      Object.assign(this.box.style, {
        position: 'absolute', pointerEvents: 'none', zIndex: '2147483647',
        display: 'none', overflow: 'visible', margin: '0', padding: '0',
      });
      for (const line of [this.lineTop, this.lineBottom]) {
        Object.assign(line.style, {
          position: 'absolute', left: '3%', right: '3%', textAlign: 'center',
          color: '#fff', whiteSpace: 'pre-line', fontFamily: 'system-ui, Segoe UI, Arial, sans-serif',
          fontWeight: '600', lineHeight: '1.3', textShadow: '0 0 4px #000, 0 0 8px #000, 0 0 2px #000',
          margin: '0', padding: '0', boxSizing: 'border-box',
        });
      }
      Object.assign(this.osd.style, {
        position: 'absolute', top: '4%', left: '0', right: '0', textAlign: 'center', color: '#ff0',
        fontFamily: 'system-ui, Segoe UI, Arial, sans-serif', fontWeight: '600',
        textShadow: '0 0 4px #000, 0 0 8px #000', display: 'none',
      });
    }

    // Коротка підказка в кадрі після гарячої клавіші.
    flash(msg) {
      this.osd.textContent = msg;
      this.osd.style.display = 'block';
      clearTimeout(this.osdTimer);
      this.osdTimer = setTimeout(() => { this.osd.style.display = 'none'; }, 1500);
    }

    // stacked: рядок має влізти в одну лінію — зменшуємо шрифт до minFit, далі дозволяємо перенос.
    fit(line) {
      const base = line.__base;
      if (!base) return;
      line.style.whiteSpace = 'nowrap';
      line.style.fontSize = base + 'px';
      const cw = line.clientWidth, sw = line.scrollWidth;
      if (!line.textContent || !cw || sw <= cw) return;
      const f = cw / sw * 0.98;
      line.style.fontSize = base * Math.max(f, CFG.stacked.minFit) + 'px';
      if (f < CFG.stacked.minFit) line.style.whiteSpace = 'normal';
    }

    schedule(delay = 400) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.select(), delay);
    }

    async select() {
      const token = ++this.token;
      const isStale = () => token !== this.token || !this.video.isConnected;
      const tracks = [...this.video.textTracks].filter(t => t.kind === 'subtitles' || t.kind === 'captions');
      if (!tracks.length) { this.setPair(null, null); return; }

      // Поки вантажимо, enforce не чіпає доріжки: старий вибір вважав би нові чужими і вимкнув би їх назад.
      this.selecting = true;
      try { await loadCues(tracks, isStale); } finally { if (token === this.token) this.selecting = false; }
      if (isStale()) return;

      const infos = tracks.map(describe);
      let bottom = best(infos, CFG.bottomLang, CFG.minCues);
      let top = null;
      const needTop = bottom ? Math.max(CFG.minCues, bottom.cues * CFG.minRatioToBottom) : CFG.minCues;
      for (const lang of CFG.topLangs) {
        top = best(infos, lang, needTop);
        if (top) break;
      }
      if (CFG.singleOnTop && bottom && !top) { top = bottom; bottom = null; }

      console.info('[dual-subs]', location.hostname,
        '| низ:', bottom ? bottom.label : '—', '| верх:', top ? top.label : '—');
      console.table(infos.map(i => ({
        label: i.label, lang: i.lang, cues: i.cues, forced: i.forced, sdh: i.sdh,
        роль: i === bottom ? 'НИЗ' : i === top ? 'ВЕРХ' : '',
      })));

      this.setPair(bottom && bottom.track, top && top.track);
    }

    setPair(bottom, top) {
      for (const t of [this.bottom, this.top]) if (t) t.removeEventListener('cuechange', this.onCue);
      this.bottom = bottom;
      this.top = top;
      for (const t of [bottom, top]) if (t) t.addEventListener('cuechange', this.onCue);
      this.apply();
    }

    // Увімкнено: наші доріжки 'hidden' (малюємо самі), решта 'disabled' — плеєр не малює дубль.
    // Вимкнено (Alt+S): гасимо лише свої, чужі не чіпаємо — працює меню плеєра.
    apply() {
      const ours = [this.bottom, this.top].filter(Boolean);
      for (const t of this.video.textTracks) {
        const want = ours.includes(t) ? (enabled ? 'hidden' : 'disabled') : (enabled ? 'disabled' : t.mode);
        if (t.mode !== want) t.mode = want;
      }
      this.render();
    }

    // Меню субтитрів плеєра перемикає mode — повертаємо свій стан. Ліміт проти пінг-понгу з плеєром.
    enforce() {
      if (!enabled || this.selecting || (!this.bottom && !this.top)) return;
      const ours = [this.bottom, this.top].filter(Boolean);
      const drift = [...this.video.textTracks].some(t => ours.includes(t) ? t.mode !== 'hidden' : t.mode !== 'disabled');
      if (!drift) return;
      const now = Date.now();
      this.enforceLog = this.enforceLog.filter(x => now - x < 2000);
      if (this.enforceLog.push(now) > 20) return;
      this.apply();
    }

    host() {
      const fs = document.fullscreenElement || document.webkitFullscreenElement;
      if (fs && fs !== this.video && fs.contains(this.video)) return fs;
      return this.video.parentElement;
    }

    layout() {
      const host = this.host();
      if (!host) return;
      if (this.box.parentElement !== host) {
        if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
        host.appendChild(this.box);
      }
      const hr = host.getBoundingClientRect();
      const vr = this.video.getBoundingClientRect();
      Object.assign(this.box.style, {
        left: (vr.left - hr.left - host.clientLeft) + 'px',
        top: (vr.top - hr.top - host.clientTop) + 'px',
        width: vr.width + 'px',
        height: vr.height + 'px',
      });
      const h = vr.height / 100, k = prefs.scale;
      this.osd.style.fontSize = (h * 2.6) + 'px';
      if (stacked()) {
        // Обидва рядки — у потоці flex-колонки, притиснутої до низу; переклад над англійським.
        const S = CFG.stacked;
        Object.assign(this.box.style, {
          flexDirection: 'column', justifyContent: 'flex-end', boxSizing: 'border-box',
          gap: (h * S.gapPct) + 'px', paddingBottom: (h * (S.offsetPct + prefs.shift)) + 'px',
        });
        for (const [line, pct, track] of [[this.lineTop, S.topSizePct, this.top], [this.lineBottom, S.bottomSizePct, this.bottom]]) {
          Object.assign(line.style, {
            position: 'relative', top: '', bottom: '', left: '', right: '', margin: '0 3%',
            lineHeight: String(S.lineHeight),
            minHeight: track ? S.lineHeight + 'em' : '0',   // порожня репліка тримає місце — рядки не скачуть
          });
          line.__base = h * pct * k;
          this.fit(line);
        }
        return;
      }
      Object.assign(this.box.style, { gap: '', paddingBottom: '0' });
      for (const line of [this.lineTop, this.lineBottom]) {
        Object.assign(line.style, { position: 'absolute', left: '3%', right: '3%', margin: '0', top: '', bottom: '',
          lineHeight: '1.3', minHeight: '0', whiteSpace: 'pre-line' });
        line.__base = 0;
      }
      this.lineTop.style.top = (h * CFG.topOffsetPct) + 'px';
      this.lineTop.style.fontSize = (h * CFG.topSizePct * k) + 'px';
      this.lineBottom.style.bottom = (h * (CFG.bottomOffsetPct + prefs.shift)) + 'px';
      this.lineBottom.style.fontSize = (h * CFG.bottomSizePct * k) + 'px';
    }

    render() {
      const on = enabled && (this.bottom || this.top);
      this.box.style.display = on ? (stacked() ? 'flex' : 'block') : 'none';
      if (!on) return;
      this.layout();
      this.renderText();
    }

    renderText() {
      const now = this.video.currentTime;
      const one = stacked();
      const text = t => {
        if (!t || !t.cues) return '';
        const s = [...t.cues].filter(c => c.startTime <= now && c.endTime > now).map(cueText).join('\n');
        return one ? s.replace(/\s*\n\s*/g, ' ') : s;
      };
      const top = text(this.top), bottom = text(this.bottom);
      if (this.lineTop.textContent !== top) { this.lineTop.textContent = top; if (one) this.fit(this.lineTop); }
      if (this.lineBottom.textContent !== bottom) { this.lineBottom.textContent = bottom; if (one) this.fit(this.lineBottom); }
    }

    // Після зміни prefs: скинути текст (інше склеювання рядків) і перемалювати.
    restyle() {
      this.lineTop.textContent = '';
      this.lineBottom.textContent = '';
      this.render();
    }

    destroy() {
      this.dead = true;
      this.token++;
      clearTimeout(this.timer);
      this.ro.disconnect();
      this.box.remove();
      controllers.delete(this);
    }
  }

  // ── Адаптер: плеєри, що малюють субтитри самі (Playerjs: rezka/voidboost та ін.) ──
  // Вони не створюють нативних доріжок, а отримують рядок "[English]url.vtt,[Русский]url.vtt"
  // з inline-конфіга або з ajax-відповіді. Перехоплюємо рядок, вантажимо файли і додаємо
  // їх у <video> як <track> — далі працює той самий контролер, що й для нативних доріжок.
  const SUB_LIST_RE = /\[([^\]]{1,40})\]\s*(https?:\/\/[^\s,"'[\]]+?\.(?:vtt|srt)(?:\?[^\s,"'[\]]*)?)/gi;
  const SUB_NONE_RE = /"subtitle"\s*:\s*(false|null|"")/;
  let ext = null;   // { key, items: [{label, url}], files: [{label, vtt}] | null }

  const toVtt = t => (/^\uFEFF?WEBVTT/.test(t) ? t
    : 'WEBVTT\n\n' + t.replace(/\r/g, '').replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2'));

  function offerSubList(text) {
    if (typeof text !== 'string' || text.length > 2e6) return;
    if (text.indexOf('.vtt') < 0 && text.indexOf('.srt') < 0) {
      if (ext && SUB_NONE_RE.test(text)) { ext = null; clearExt(); }   // нова озвучка без субтитрів
      return;
    }
    // JSON кодує кирилицю як \uXXXX: "[Русский]" стає 42 символами і не влазить у мітку регулярки.
    const s = text.replace(/\\\//g, '/')
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    const items = [];
    let m;
    SUB_LIST_RE.lastIndex = 0;
    while ((m = SUB_LIST_RE.exec(s))) {
      if (!items.some(i => i.url === m[2])) items.push({ label: m[1].trim(), url: m[2] });
    }
    if (!items.length) return;
    const key = items.map(i => i.url).join('|');
    if (ext && ext.key === key) return;
    const e = ext = { key, items, files: null };
    Promise.all(items.map(it => fetch(it.url)
      .then(r => r.text())
      .then(t => ({ label: it.label, vtt: toVtt(t) }))
      .catch(err => { console.info('[dual-subs] не завантажив', it.label, err.message); return null; })))
      .then(files => {
        if (ext !== e) return;
        e.files = files.filter(Boolean);
        injectExt();
      });
  }

  function mainVideo() {
    let best = null, area = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      if (r.width * r.height > area) { area = r.width * r.height; best = v; }
    }
    return best;
  }

  function clearExt() {
    document.querySelectorAll('track[data-dual-subs]').forEach(t => { URL.revokeObjectURL(t.src); t.remove(); });
    document.querySelectorAll('video[data-dual-subs-key]').forEach(v => delete v.dataset.dualSubsKey);
  }

  function injectExt() {
    if (!ext || !ext.files || !ext.files.length) return;
    const v = mainVideo();
    if (!v || v.dataset.dualSubsKey === ext.key) return;
    clearExt();
    for (const f of ext.files) {
      const tr = document.createElement('track');
      tr.kind = 'subtitles';
      tr.label = f.label;
      tr.dataset.dualSubs = '1';
      tr.src = URL.createObjectURL(new Blob([f.vtt], { type: 'text/vtt' }));
      v.appendChild(tr);
    }
    v.dataset.dualSubsKey = ext.key;
    attach(v);
    [0, 1500, 4000].forEach(d => setTimeout(muteOwnSubs, d));   // плеєр вмикає свої субтитри із затримкою
  }

  // Вимикаємо власний рендер субтитрів Playerjs, інакше верхній рядок задублюється.
  function muteOwnSubs() {
    if (!enabled || typeof window.Playerjs !== 'function') return;
    for (const k of Object.keys(window)) {
      let p;
      try { p = window[k]; } catch (e) { continue; }
      if (p instanceof window.Playerjs) try { p.api('subtitle', -1); } catch (e) { /* інша версія API */ }
    }
  }

  // Ajax-відповіді (rezka: /ajax/get_cdn_series/). Хук ставиться на document-start, до скриптів сторінки.
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', () => {
      try { if (!this.responseType || this.responseType === 'text') offerSubList(this.responseText); } catch (e) { /* бінарна відповідь */ }
    });
    return xhrSend.apply(this, arguments);
  };
  const pageFetch = window.fetch;
  window.fetch = function () {
    const p = pageFetch.apply(this, arguments);
    p.then(r => {
      const ct = r.headers.get('content-type') || '';
      if (/json|javascript|text\/(plain|html)/.test(ct)) r.clone().text().then(offerSubList, () => {});
    }, () => {});
    return p;
  };

  // Inline-конфіг плеєра (rezka без #t:… у посиланні: субтитри озвучки за замовчуванням).
  const scanInline = () => { for (const s of document.scripts) if (!s.src) offerSubList(s.textContent); };
  // Копія, запущена в уже готовому iframe (adoptFrames), DOMContentLoaded не дочекається.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scanInline);
  else scanInline();

  // Firefox при зміні джерела відео (реклама → фільм) очищає репліки <track> і не вантажить файл знову:
  // readyState лишається 2. Новий елемент з тими ж атрибутами вантажить файл з нуля (cloneNode не годиться:
  // клон успадковує readyState=2). Порожній файл сюди не потрапить — міняємо лише доріжку, в якій репліки вже були.
  function reviveTracks(video) {
    let revived = false;
    for (const tr of video.querySelectorAll('track')) {
      const cues = tr.track.cues;   // null у вимкненої доріжки — це не втрата, а наш же mode='disabled'
      if (!cues) continue;
      if (cues.length > 0) { tr.__dualSubsSeen = cues.length; continue; }
      if (tr.readyState === 2 && tr.__dualSubsSeen > 0) {
        console.info('[dual-subs] доріжка втратила репліки, перезавантажую:', tr.label);
        const fresh = document.createElement('track');
        for (const a of tr.attributes) fresh.setAttribute(a.name, a.value);
        tr.replaceWith(fresh);
        revived = true;
      }
    }
    // Firefox не завжди шле addtrack на заміну елемента — перевибір запускаємо самі.
    if (revived) for (const c of controllers) if (c.video === video) c.schedule(0);
  }

  // ── Пошук відео ────────────────────────────────────────────────────────────
  function attach(video) {
    if (!(video instanceof HTMLVideoElement) || attached.has(video)) return;
    attached.add(video);
    controllers.add(new Controller(video));
  }

  // Плеєр, який сайт записує в iframe без src (kinogoua «Плеер 2»), менеджер скриптів пропускає:
  // для нього це about:blank. Походження в кадру спільне з нами, тож запускаємо там свою копію самі.
  function adoptFrames() {
    for (const f of document.querySelectorAll('iframe')) {
      let d;
      try { d = f.contentDocument; } catch (e) { continue; }   // чужий домен — там працює копія від менеджера
      if (!d || !d.documentElement || d.documentElement.hasAttribute('data-dual-subs')) continue;
      if (f.__dualSubsTried === d || !d.querySelector('video')) continue;
      f.__dualSubsTried = d;
      const s = d.createElement('script');
      s.textContent = '(' + dualSubs + ')();';
      (d.head || d.documentElement).appendChild(s);
      s.remove();
      if (!d.documentElement.hasAttribute('data-dual-subs')) console.info('[dual-subs] не запустився в iframe (CSP?):', f.id || f.src);
    }
  }

  function scan() {
    // Прапорець для інших копій і adoptFrames батька: на document-start <html> могло ще не бути.
    const html = document.documentElement;
    if (html && !html.hasAttribute('data-dual-subs')) html.setAttribute('data-dual-subs', '1');
    adoptFrames();
    document.querySelectorAll('video').forEach(attach);
    for (const c of controllers) if (!c.video.isConnected) c.destroy(); else reviveTracks(c.video);
    injectExt();   // відео могло з'явитись пізніше за список субтитрів або бути замінене
    checkListeners();
  }

  function command(cmd) {
    if (cmd === 'toggle') {
      enabled = !enabled;
      controllers.forEach(c => c.apply());
      if (enabled) muteOwnSubs();
      console.info('[dual-subs]', enabled ? 'увімкнено' : 'вимкнено');
    } else {
      const round = x => Math.round(x * 100) / 100;
      if (cmd === 'layout') prefs.layout = stacked() ? 'split' : 'stacked';
      else if (cmd === 'bigger') prefs.scale = round(Math.min(2.5, prefs.scale * 1.1));
      else if (cmd === 'smaller') prefs.scale = round(Math.max(0.4, prefs.scale / 1.1));
      else if (cmd === 'up') prefs.shift = Math.min(40, prefs.shift + 1);
      else if (cmd === 'down') prefs.shift = Math.max(-10, prefs.shift - 1);
      else if (cmd === 'reset') Object.assign(prefs, PREFS_DEFAULT());
      savePrefs();
      const msg = (stacked() ? 'обидва знизу' : 'згори + знизу') + ` · розмір ${Math.round(prefs.scale * 100)}%`
        + ` · зсув ${prefs.shift > 0 ? '+' : ''}${prefs.shift}`;
      controllers.forEach(c => { c.restyle(); c.flash(msg); });
      console.info('[dual-subs]', msg);
    }
    // Плеєр часто в iframe, а фокус — у батька (або навпаки): передаємо команду дочірнім копіям.
    for (let i = 0; i < window.frames.length; i++) {
      try { window.frames[i].postMessage({ dualSubs: cmd }, '*'); } catch (e) { /* фрейм зник */ }
    }
  }

  // Медіа-події не спливають, але проходять capture-фазу через document.
  const onMeta = e => {
    attach(e.target);
    if (e.target instanceof HTMLVideoElement) setTimeout(() => reviveTracks(e.target), 300);
  };
  const onPlay = e => attach(e.target);
  const onFullscreen = () => controllers.forEach(c => c.render());
  const onMessage = e => {
    const cmd = e.data && e.data.dualSubs;
    if (e.source !== window.parent || e.source === window || !Object.hasOwn(CFG.keys, cmd)) return;
    command(cmd);
  };
  const onKey = e => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const cmd = Object.keys(CFG.keys).find(k => CFG.keys[k] === e.code);
    if (!cmd) return;
    command(cmd);
    e.preventDefault();
    e.stopPropagation();
  };
  let alive = false;
  const onPing = () => { alive = true; };

  // document.open() (сайт пише плеєр в iframe) стирає слухачі window і document, а таймери лишає.
  // scan() перевіряє це пінгом і реєструє заново; ті самі функції браузер не дублює.
  function listen() {
    window.addEventListener('dual-subs-ping', onPing);
    document.addEventListener('loadedmetadata', onMeta, true);
    document.addEventListener('play', onPlay, true);
    document.addEventListener('fullscreenchange', onFullscreen);
    document.addEventListener('webkitfullscreenchange', onFullscreen);
    window.addEventListener('message', onMessage);
    window.addEventListener('keydown', onKey, true);
  }
  function checkListeners() {
    alive = false;
    window.dispatchEvent(new Event('dual-subs-ping'));
    if (alive) return;
    listen();
    console.info('[dual-subs] слухачі подій відновлено (document.open?)');
  }

  listen();
  setInterval(scan, 2000);
  scan();
})();
