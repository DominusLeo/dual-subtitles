// Тестовий стенд: стоковий Firefox через WebDriver BiDi, тимчасовий профіль,
// dual-subtitles.user.js підставляється preload-скриптом у кожен фрейм до коду сайту.
// Запуск: node run.mjs <url> [steps.json] [outDir]
//   steps.json — масив кроків: {click: "css", frame?: "підрядок URL"} | {wait: ms}
//                | {play: true} | {seek: секунд} | {shot: "ім'я"}
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const FIREFOX = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
const SCRIPT = path.resolve(import.meta.dirname, '..', 'dual-subtitles.user.js');

const [url, stepsFile, outArg] = process.argv.slice(2);
if (!url) { console.error('usage: node run.mjs <url> [steps.json] [outDir]'); process.exit(2); }
const steps = stepsFile ? JSON.parse(fs.readFileSync(stepsFile, 'utf8')) : [{ wait: 12000 }];
const outDir = outArg || path.resolve(import.meta.dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });

const logs = [];
const mid = [];   // знімки кроку {probe: "ім'я"}
const stamp = () => new Date().toISOString().slice(11, 19);

// Стан скрипта в одному фреймі: прапорець, відео, доріжки, текст оверлея.
const PROBE = () => {
  const vids = [...document.querySelectorAll('video')];
  const box = document.querySelectorAll('.dual-subs-box');
  return {
    flag: document.documentElement && document.documentElement.getAttribute('data-dual-subs'),
    href: String(location.href).slice(0, 80),
    frameEl: (() => { try { return window.frameElement ? window.frameElement.outerHTML.slice(0, 200) : (window === top ? 'top' : 'cross-origin'); } catch (e) { return 'err'; } })(),
    videos: vids.map(v => ({
      rs: v.readyState, t: Math.round(v.currentTime), paused: v.paused,
      tracks: [...v.textTracks].map(t => {
        const cues = t.cues ? [...t.cues] : [];
        const cover = cues.filter(c => c.startTime <= v.currentTime && c.endTime >= v.currentTime);
        return `${t.label}|${t.mode}|cues=${cues.length}|active=${t.activeCues ? t.activeCues.length : null}`
          + `|cover=${cover.length}|first=${cues[0] ? cues[0].startTime.toFixed(1) : '-'}|last=${cues.length ? cues[cues.length - 1].endTime.toFixed(0) : '-'}`
          + (cover[0] ? `|text=${String(cover[0].text).slice(0, 40)}` : '');
      }),
    })),
    trackEls: [...document.querySelectorAll('track')].map(tr => `${tr.label}|rs=${tr.readyState}|mode=${tr.track.mode}`
      + `|cues=${tr.track.cues ? tr.track.cues.length : null}|ours=${!!tr.dataset.dualSubs}|src=${String(tr.src).slice(0, 30)}`
      + `|inVideo=${tr.parentElement && tr.parentElement.tagName}`),
    events: (window.__dbgEvents || []).slice(-40),
    boxes: [...box].map(b => ({
      display: b.style.display, size: `${b.style.width}x${b.style.height}`,
      top: b.children[0] && b.children[0].textContent, bottom: b.children[1] && b.children[1].textContent,
      // Геометрія рядків відносно боксу: y — верх рядка, h — висота (один рядок ≈ fontSize × lineHeight).
      lines: [...b.children].slice(0, 2).map(l => {
        const r = l.getBoundingClientRect(), br = b.getBoundingClientRect();
        return { y: Math.round(r.top - br.top), h: Math.round(r.height), fs: l.style.fontSize, ws: l.style.whiteSpace, over: l.scrollWidth > l.clientWidth };
      }),
      osd: b.children[2] && b.children[2].style.display !== 'none' ? b.children[2].textContent : '',
    })),
  };
};

// evaluate у фреймі, що саме перезавантажується (реклама в Chrome), може не повернутись ніколи.
const withTimeout = (p, ms = 10000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('evaluate timeout')), ms))]);

const findFrame =(page, part) => (part ? page.frames().find(f => f.url().includes(part)) : page.mainFrame());

async function probeAll(page) {
  const res = [];
  for (const f of page.frames()) {
    let host = f.url();
    try { host = new URL(host).host + new URL(host).pathname.slice(0, 40); } catch (e) { /* about:blank */ }
    try { res.push({ frame: host, ...(await withTimeout(f.evaluate(PROBE))) }); } catch (e) { res.push({ frame: host, error: e.message.slice(0, 120) }); }
  }
  return res.filter(r => r.error || r.flag || r.videos.length);
}

// BROWSER=chrome — той самий сценарій у Chrome (регресія); профіль тимчасовий, як і для Firefox.
const VM_UUID = '5f0c1a2b-0000-4000-8000-000000000001';
const CHROME ='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const useChrome = process.env.BROWSER === 'chrome';
const browser = await puppeteer.launch(useChrome ? {
  browser: 'chrome',
  executablePath: CHROME,
  headless: false,
  defaultViewport: { width: 1280, height: 800 },
  args: ['--autoplay-policy=no-user-gesture-required'],
} : {
  browser: 'firefox',
  executablePath: FIREFOX,
  headless: false,
  defaultViewport: { width: 1280, height: 800 },
  extraPrefsFirefox: {
    'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0,
    // Фіксована внутрішня адреса Violentmonkey: moz-extension://<VM_UUID>/ — щоб відкривати його сторінки напряму.
    'extensions.webextensions.uuids': JSON.stringify({ '{aecec67f-0d10-4fa7-b7c7-609a2db280cf}': VM_UUID }),
  },
});
// EXT=1 — середовище юзера: розширення з ext/*.xpi (Adblock Plus, Violentmonkey), скрипт ставить сам Violentmonkey
// з локального сервера (127.0.0.1:8766), а не preload стенду.
const useExt = process.env.EXT === '1';
const EXT_DIR = path.resolve(import.meta.dirname, 'ext');
const SCRIPT_URL = 'http://127.0.0.1:8766/dual-subtitles.user.js';
const useVM = useExt && 'violentmonkey'.includes(process.env.EXT_ONLY || 'violentmonkey');

// Сторінка підтвердження VM стенду невидима (puppeteer не відстежує moz-extension-навігацію), тому скрипт
// передаємо фоновій частині VM тією ж командою, яку шле його сторінка підтвердження.
async function installViaVMCommand() {
  const d = await browser.newPage();
  d.goto(`moz-extension://${VM_UUID}/options/index.html`, { timeout: 15000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 4000));
  const code = fs.readFileSync(SCRIPT, 'utf8');
  try {
    const r = await withTimeout(d.evaluate(async (code, url) => {
      const res = await browser.runtime.sendMessage({ cmd: 'ParseScript', data: { code, url, from: url } });
      return JSON.stringify(res).slice(0, 300);
    }, code, SCRIPT_URL), 15000);
    logs.push(`${stamp()} [harness] VM ParseScript: ${r}`);
  } catch (e) { logs.push(`${stamp()} [harness] VM ParseScript error: ${e.message.slice(0, 200)}`); }
  await new Promise(r => setTimeout(r, 1500));
  try { await d.screenshot({ path: path.join(outDir, 'vm-options.png') }); } catch (e) { /* */ }
}

async function installViaVM() {
  const p = await browser.newPage();
  p.goto(SCRIPT_URL).catch(() => {});
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    for (const c of await browser.pages()) {
      if (!c.url().startsWith('moz-extension://') || !c.url().includes('confirm')) continue;
      try {
        const clicked = await withTimeout(c.evaluate(() => {
          const b = [...document.querySelectorAll('button')].find(x => /install|встанов|установ|reinstall|confirm/i.test(x.textContent) && !x.disabled);
          if (b) b.click();
          return b ? b.textContent.trim() : null;
        }));
        if (clicked) { logs.push(`${stamp()} [harness] VM confirm: ${clicked}`); await new Promise(r => setTimeout(r, 2000)); return; }
      } catch (e) { logs.push(`${stamp()} [harness] VM confirm error: ${e.message.slice(0, 120)}`); }
    }
  }
  logs.push(`${stamp()} [harness] VM confirm page not found; pages: ${(await browser.pages()).map(x => x.url()).join(' , ')}`);
  try { await p.screenshot({ path: path.join(outDir, 'vm-install.png') }); } catch (e) { /* вкладку закрито */ }
  // Діагностика: чи доступна сторінка розширення стенду взагалі.
  try {
    const d = await browser.newPage();
    await d.goto(`moz-extension://${VM_UUID}/options/index.html`, { timeout: 15000 }).catch(e => logs.push(`${stamp()} [harness] VM options goto: ${e.message.slice(0, 120)}`));
    logs.push(`${stamp()} [harness] VM options url=${d.url()} title=${await withTimeout(d.title()).catch(e => e.message)}`);
    await d.screenshot({ path: path.join(outDir, 'vm-options.png') });
  } catch (e) { logs.push(`${stamp()} [harness] VM options error: ${e.message.slice(0, 120)}`); }
}

try {
  if (useExt) {
    // EXT_ONLY=adblock — лише файли, чиє ім'я містить підрядок (розділити внесок розширень).
    for (const f of fs.readdirSync(EXT_DIR).filter(x => x.endsWith('.xpi') && x.includes(process.env.EXT_ONLY || ''))) {
      logs.push(`${stamp()} [harness] ext ${f} id=${await browser.installExtension(path.join(EXT_DIR, f))}`);
    }
    await new Promise(r => setTimeout(r, 10000));   // Adblock Plus вантажить списки фільтрів після встановлення
    if (useVM) await installViaVMCommand();
  }
  const page = (await browser.pages())[0] || await browser.newPage();
  page.on('console', m => logs.push(`${stamp()} [${m.type()}] ${m.text()}`.slice(0, 400)));
  page.on('pageerror', e => logs.push(`${stamp()} [pageerror] ${String(e.message || e).slice(0, 300)}`));
  // Журнал медіа-подій і змін доріжок: що сталося з <video> між пробами.
  await page.evaluateOnNewDocument(() => {
    const log = window.__dbgEvents = [];
    const t0 = Date.now();
    const push = s => { log.push(`${((Date.now() - t0) / 1000).toFixed(1)} ${s}`); if (log.length > 400) log.shift(); };
    const id = v => { if (!v.__dbgId) v.__dbgId = 'v' + (window.__dbgN = (window.__dbgN || 0) + 1); return v.__dbgId; };
    for (const ev of ['emptied', 'loadstart', 'loadedmetadata', 'abort', 'error']) {
      document.addEventListener(ev, e => {
        const v = e.target;
        if (v instanceof HTMLMediaElement) push(`${ev} ${id(v)} src=${String(v.currentSrc || v.src).slice(0, 40)} tracks=${v.textTracks.length}`);
        else if (v instanceof HTMLTrackElement) push(`track-${ev} ${v.label} rs=${v.readyState}`);
      }, true);
    }
    document.addEventListener('load', e => { if (e.target instanceof HTMLTrackElement) push(`track-load ${e.target.label} cues=${e.target.track.cues && e.target.track.cues.length}`); }, true);
    const rev = URL.revokeObjectURL;
    URL.revokeObjectURL = function (u) { push(`revoke ${String(u).slice(0, 40)}`); return rev.apply(this, arguments); };
  });
  if (!useVM) await page.evaluateOnNewDocument(fs.readFileSync(SCRIPT, 'utf8'));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  for (const s of steps) {
    console.error(`${stamp()} step ${JSON.stringify(s)}`);
    if (s.wait) await new Promise(r => setTimeout(r, s.wait));
    else if (s.click) {
      const f = findFrame(page, s.frame);
      if (!f) { logs.push(`${stamp()} [harness] frame not found: ${s.frame}`); continue; }
      try { await f.click(s.click); } catch (e) { logs.push(`${stamp()} [harness] click ${s.click}: ${e.message.slice(0, 120)}`); }
    } else if (s.play || s.seek !== undefined) {
      for (const f of page.frames()) {
        try {
          await withTimeout(f.evaluate(async (seek) => {
            for (const v of document.querySelectorAll('video')) {
              v.muted = true;
              if (seek !== undefined) v.currentTime = seek;
              try { await v.play(); } catch (e) { /* без джерела */ }
            }
          }, s.seek));
        } catch (e) { /* фрейм зник */ }
      }
    } else if (s.seekCue !== undefined) {
      // Перемотати всередину N-ї репліки першої доріжки, в якій є репліки.
      for (const f of page.frames()) {
        try {
          const r = await withTimeout(f.evaluate(async (n) => {
            const out = [];
            for (const v of document.querySelectorAll('video')) {
              const t = [...v.textTracks].find(x => x.cues && x.cues.length > n);
              if (!t) continue;
              const target = t.cues[n].startTime + 0.3;
              v.pause();
              const done = new Promise(res => { v.addEventListener('seeked', res, { once: true }); setTimeout(res, 8000); });
              v.currentTime = target;
              await done;
              out.push(`seek ${t.label} cue#${n} target=${target.toFixed(1)} now=${v.currentTime.toFixed(1)} text=${String(t.cues[n].text).slice(0, 40)}`);
            }
            return out;
          }, s.seekCue), 20000);
          r.forEach(x => logs.push(`${stamp()} [harness] ${x}`));
        } catch (e) { /* фрейм зник */ }
      }
    } else if (s.eval) {
      // Вираз у кожному фреймі; непорожній результат — у журнал.
      for (const f of page.frames()) {
        try {
          const r = await withTimeout(f.evaluate(s.eval));
          if (r) logs.push(`${stamp()} [harness] eval ${f.url().slice(0, 40)}: ${JSON.stringify(r).slice(0, 200)}`);
        } catch (e) { /* фрейм зник */ }
      }
    } else if (s.key) {
      // "Alt+KeyL" — у фокусований фрейм (за замовчуванням верхній документ).
      const parts = s.key.split('+'), main = parts.pop();
      for (const m of parts) await page.keyboard.down(m);
      await page.keyboard.press(main);
      for (const m of parts.reverse()) await page.keyboard.up(m);
    } else if (s.probe) {
      mid.push({ at: stamp(), name: s.probe, state: await probeAll(page) });
    } else if (s.shot) {
      await page.screenshot({ path: path.join(outDir, `${s.shot}.png`) });
    }
  }

  const state = await probeAll(page);
  await page.screenshot({ path: path.join(outDir, 'final.png') });
  const report = { url, finalUrl: page.url(), mid, state, dualSubsLogs: logs.filter(l => l.includes('dual-subs')), otherLogs: logs.filter(l => !l.includes('dual-subs')).slice(-15) };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
