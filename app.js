/* 第二次段考單字卡 — shared app code for the online (Artifact) and offline (PWA) builds. */
(function () {
  'use strict';
  const APP = window.VOCAB_APP || { name: '第二次段考單字卡', mode: 'online' };
  const STORE_KEY = 'vocab-progress-v1';
  const INTERVALS = [1, 3, 7, 14, 30];
  const SRC_ORDER = ['課本', '雜誌', '核心', '成功閱讀', '學測翻譯'];
  const POS_NAMES = { n: '名詞', v: '動詞', adj: '形容詞', adv: '副詞', prep: '介系詞', phrase: '片語', other: '其他' };

  let DATA = null, WORDS = [], BYID = {};
  const $ = (s, el) => (el || document).querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------------- dates ----------------
  function today(off) {
    const d = new Date(); if (off) d.setDate(d.getDate() + off);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function addDays(ds, n) {
    const [y, m, d] = ds.split('-').map(Number); const t = new Date(y, m - 1, d + n);
    return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
  }

  // ---------------- state ----------------
  const DEFAULT_SETTINGS = { accent: 'en-US', voiceURI: '', rate: 'normal', autoplay: true, newPerDay: 10, theme: 'system', hideZh: false, reviewScope: 'all' };
  function freshState() {
    return { v: 1, updatedAt: 0, marks: {}, srs: {}, pos: {}, settings: Object.assign({}, DEFAULT_SETTINGS), seed: Math.floor(Math.random() * 1e9), order: 'orig', filter: defaultFilter(), view: 'cards', today: null };
  }
  function defaultFilter() { return { src: 'all', sub: [], pos: [], theme: [], mark: 'all' }; }
  let S = freshState();
  function normalizeState(o) {
    const s = freshState();
    if (!o || typeof o !== 'object') return s;
    for (const k of ['marks', 'srs', 'pos']) if (o[k] && typeof o[k] === 'object') s[k] = o[k];
    s.settings = Object.assign({}, DEFAULT_SETTINGS, o.settings || {});
    if (typeof o.seed === 'number') s.seed = o.seed;
    if (o.order === 'rand' || o.order === 'orig') s.order = o.order;
    if (o.filter && typeof o.filter === 'object') s.filter = Object.assign(defaultFilter(), o.filter);
    if (typeof o.view === 'string') s.view = o.view;
    if (o.today && typeof o.today === 'object') s.today = o.today;
    s.updatedAt = o.updatedAt || 0;
    return s;
  }
  function loadLocal() {
    try { const raw = localStorage.getItem(STORE_KEY); if (raw) return normalizeState(JSON.parse(raw)); } catch (e) { /* storage blocked */ }
    return null;
  }
  let saveTimer = null;
  function save(touch) {
    if (touch !== false) S.updatedAt = Date.now();
    try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) { /* ignore */ }
    Cloud.schedule();
  }

  // ---------------- cloud sync (online Artifact only) ----------------
  const Cloud = {
    ref: null, ok: false, writing: false, dirty: false, timer: null, label: '',
    async init() {
      if (!window.claude || typeof window.claude.use !== 'function') { this.label = APP.mode === 'pwa' ? '' : '進度存在這個瀏覽器'; renderSync(); return; }
      try {
        const [db, user] = await Promise.all([window.claude.use('db'), window.claude.use('user')]);
        if (!db || !user) { this.label = '進度存在這個瀏覽器'; renderSync(); return; }
        const uid = await user.id();
        if (!uid) { this.label = '進度存在這個瀏覽器'; renderSync(); return; }
        this.ref = db.doc('data/users/' + uid + '/progress');
        const snap = await this.ref.get();
        if (snap.exists) {
          const d = snap.data() || {};
          let remote = null; try { remote = normalizeState(JSON.parse(d.json || '{}')); } catch (e) { remote = null; }
          if (remote && (remote.updatedAt || 0) > (S.updatedAt || 0)) {
            S = remote; save(false); applyTheme(); render();
          } else if ((S.updatedAt || 0) > (remote ? remote.updatedAt || 0 : 0)) { this.dirty = true; }
        } else { this.dirty = true; }
        this.ok = true; this.label = '進度已同步到你的帳號'; renderSync();
        if (this.dirty) this.flush();
      } catch (e) { this.label = '進度存在這個瀏覽器'; renderSync(); }
    },
    schedule() {
      if (!this.ok) return; this.dirty = true;
      clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), 2500);
    },
    async flush() {
      if (!this.ok || !this.ref || this.writing || !this.dirty) return;
      this.writing = true; this.dirty = false;
      try { await this.ref.set({ updatedAt: S.updatedAt, json: JSON.stringify(S) }); this.label = '進度已同步到你的帳號'; }
      catch (e) { this.label = '同步暫時失敗，進度先存在這個瀏覽器'; this.dirty = true; }
      this.writing = false; renderSync();
      if (this.dirty) { clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), 4000); }
    }
  };
  function renderSync() { const el = $('#syncLabel'); if (el) el.textContent = Cloud.label || ''; }

  // ---------------- theme ----------------
  const hostTheme = document.documentElement.getAttribute('data-theme');
  function applyTheme() {
    const t = S.settings.theme;
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    else if (hostTheme) document.documentElement.setAttribute('data-theme', hostTheme);
    else document.documentElement.removeAttribute('data-theme');
  }

  // ---------------- speech ----------------
  const TTS = {
    supported: 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function',
    voices: [], ready: false, cur: null,
    init() {
      if (!this.supported) { this.ready = true; return; }
      const load = () => {
        const vs = window.speechSynthesis.getVoices() || [];
        this.voices = vs.filter((v) => /^en([-_]|$)/i.test(v.lang));
        if (vs.length) this.ready = true;
        refreshVoiceUI();
      };
      load();
      if (typeof window.speechSynthesis.addEventListener === 'function') window.speechSynthesis.addEventListener('voiceschanged', load);
      else window.speechSynthesis.onvoiceschanged = load;
      setTimeout(() => { this.ready = true; load(); }, 2500);
    },
    hasEnglish() { return this.supported && this.voices.length > 0; },
    pick() {
      const st = S.settings; const offline = navigator.onLine === false;
      let pool = this.voices.slice();
      if (offline || APP.mode === 'pwa') { const loc = pool.filter((v) => v.localService); if (loc.length && offline) pool = loc; }
      if (st.voiceURI) { const v = pool.find((x) => x.voiceURI === st.voiceURI); if (v) return v; }
      const acc = st.accent.toLowerCase();
      const byAcc = pool.filter((v) => v.lang.replace('_', '-').toLowerCase().startsWith(acc));
      const list = byAcc.length ? byAcc : pool;
      const local = list.filter((v) => v.localService);
      return (local.length && (offline || APP.mode === 'pwa') ? local[0] : list.find((v) => v.default) || list[0]) || null;
    },
    speak(text, slow, quiet) {
      if (!text) return false;
      if (!this.hasEnglish()) { if (!quiet) noVoiceToast(); return false; }
      const v = this.pick(); if (!v) { if (!quiet) noVoiceToast(); return false; }
      try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.voice = v; u.lang = v.lang;
        u.rate = (slow || S.settings.rate === 'slow') ? 0.6 : 0.95;
        this.cur = u;
        // iOS sometimes needs a tick after cancel()
        setTimeout(() => { if (this.cur === u) window.speechSynthesis.speak(u); }, 40);
        return true;
      } catch (e) { return false; }
    },
    stop() { if (this.supported) { this.cur = null; try { window.speechSynthesis.cancel(); } catch (e) { } } }
  };
  function noVoiceToast() { toast('這台裝置沒有英文語音，所以不播放（避免用其他語言念英文）。請看「設定 › 語音」的安裝方法，或點詞典連結聽真人發音。', 5200); }

  // ---------------- filters & ordering ----------------
  function srcOf(w, src) { return w.refs.filter((r) => r.src === src); }
  function subKey(r) {
    if (r.src === '課本') return 'L' + r.lesson;
    if (r.src === '雜誌') return 'U' + r.unit;
    if (r.src === '核心') return 'U' + String(r.unit).padStart(2, '0');
    return 'U' + r.unit;
  }
  function matchFilter(w, f) {
    if (f.src === 'multi') { if (new Set(w.refs.map((r) => r.src)).size < 2) return false; }
    else if (f.src !== 'all') {
      const rs = srcOf(w, f.src); if (!rs.length) return false;
      if (f.sub && f.sub.length && !rs.some((r) => f.sub.includes(subKey(r)))) return false;
    }
    if (f.pos && f.pos.length && !w.cat.some((c) => f.pos.includes(c))) return false;
    if (f.theme && f.theme.length && !f.theme.includes(w.theme)) return false;
    const mk = S.marks[w.id];
    if (f.mark === 'again' && mk !== 'again') return false;
    if (f.mark === 'known' && mk !== 'known') return false;
    if (f.mark === 'none' && mk) return false;
    return true;
  }
  function seqIn(w, src) { const r = srcOf(w, src)[0]; return r ? r.seq : 1e9; }
  function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) { let a = seed >>> 0; return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function filterKey(f) { return JSON.stringify([f.src, (f.sub || []).slice().sort(), (f.pos || []).slice().sort(), (f.theme || []).slice().sort(), f.mark]); }
  function listFor(f, order) {
    let L = WORDS.filter((w) => matchFilter(w, f));
    if (SRC_ORDER.includes(f.src)) L.sort((a, b) => seqIn(a, f.src) - seqIn(b, f.src));
    if (order === 'rand') {
      const r = rng(S.seed ^ hashStr(filterKey(f)));
      L = L.slice(); for (let i = L.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [L[i], L[j]] = [L[j], L[i]]; }
    }
    return L;
  }
  function posKey() { return filterKey(S.filter) + '|' + S.order; }
  function filterLabel(f) {
    const parts = [];
    const srcName = { all: '全部', multi: '多來源', '課本': '課本', '雜誌': '雜誌', '核心': '核心單字', '成功閱讀': '成功閱讀', '學測翻譯': '學測翻譯' }[f.src] || '全部';
    parts.push(srcName + (f.sub && f.sub.length ? ' ' + f.sub.join('、') : ''));
    if (f.pos && f.pos.length) parts.push(f.pos.map((p) => POS_NAMES[p]).join('、'));
    if (f.theme && f.theme.length) parts.push(f.theme.join('、'));
    if (f.mark !== 'all') parts.push({ again: '再複習', known: '已熟悉', none: '未標記' }[f.mark]);
    return parts.join('・');
  }

  // ---------------- render helpers ----------------
  function highlight(en, w) {
    if (!w.hl) return esc(en);
    let rx; try { rx = new RegExp(w.hl, 'gi'); } catch (e) { return esc(en); }
    let out = '', last = 0, m;
    while ((m = rx.exec(en))) { if (!m[0]) { rx.lastIndex++; continue; } out += esc(en.slice(last, m.index)) + '<mark>' + esc(m[0]) + '</mark>'; last = m.index + m[0].length; }
    return out + esc(en.slice(last));
  }
  function dictLinks(w) {
    const q = encodeURIComponent(w.w.replace(/\s*\/\s*/g, ' ').replace(/\.\.\.|…/g, ' ').replace(/\s+/g, ' ').trim());
    return [
      ['劍橋英漢（繁）', 'https://dictionary.cambridge.org/zht/search/direct/?datasetsearch=english-chinese-traditional&q=' + q],
      ['Oxford Learner\'s', 'https://www.oxfordlearnersdictionaries.com/search/american_english/?q=' + q],
      ['Merriam-Webster', 'https://www.merriam-webster.com/dictionary/' + q],
      ['Yahoo 奇摩字典', 'https://tw.dictionary.search.yahoo.com/search?p=' + q],
    ];
  }
  const VF = { ok: ['已核對', 'ok'], mw: ['已核對', 'ok'], cmu: ['自動轉寫', ''], manual: ['人工選定', ''], src: ['沿用教材', ''], check: ['待確認', 'check'] };
  function aiTag(w, field) { return w.ai && w.ai.includes(field) ? '<span class="tag ai">AI 補寫</span>' : ''; }
  function longWord(w) { return w.w.length > 16; }

  function cardHTML(w, opts) {
    opts = opts || {};
    const mk = S.marks[w.id];
    const srcs = w.refs.map((r) => `<span class="src">${esc(r.label)}</span>`).join('');
    const badge = mk === 'again' ? '<span class="markbadge again">再複習</span>' : mk === 'known' ? '<span class="markbadge known">已熟悉</span>' : '';
    const alts = (w.kkAlt || []).length ? `<span class="alt">（教材另標 ${esc(w.kkAlt.join('、'))}）</span>` : '';
    const ms = w.m.map((m) => `<li><span class="pos">${esc(m.p)}</span><span class="zh">${esc(m.z)}</span><span class="msrc">〔${esc(m.s.join('、'))}〕</span></li>`).join('');
    const exs = w.ex.map((x, i) => `<div><div class="en">${highlight(x.en, w)}</div><div class="exzh zhwrap">${esc(x.zh)}${x.zai && x.l.indexOf('補充') < 0 ? ' <span class="tag ai">AI 中譯</span>' : ''}</div><div class="exmeta"><span class="tag${x.l === '補充例句' ? ' ai' : ''}">${esc(x.l === '補充例句' ? '補充例句（AI 補寫）' : x.l)}${x.s && x.s !== 'AI' && x.l !== '補充例句' ? '・' + esc(x.s) : ''}</span><button class="btn small" data-act="sayex" data-i="${i}" type="button">▶ 播放例句</button></div></div>`).join('');
    return `<article class="card${S.settings.hideZh && !opts.showZh ? ' hidden-zh' : ''}" data-id="${w.id}">
      <div class="srcline">${badge}${srcs}</div>
      <div class="word${longWord(w) ? ' long' : ''}" lang="en">${esc(w.w)}</div>
      <div class="phon"><span><span class="lab">KK</span>[${esc(w.kk)}]</span><span><span class="lab">IPA</span>/${esc(w.ipa)}/</span>${alts}</div>
      <div class="zhwrap" data-act="reveal"><ul class="meanings">${ms}</ul></div>
      ${S.settings.hideZh && !opts.showZh ? '<div class="hint">中文已隱藏，點模糊處或按「顯示中文」查看。</div>' : ''}
      <div class="ex">${exs}</div>
    </article>`;
  }
  function detailsHTML(w) {
    const out = [];
    if (w.col && w.col.length) out.push(`<section class="sec"><h3>常見搭配${aiTag(w, '搭配詞')}</h3><ul>${w.col.map((c) => `<li><span class="en">${esc(c[0])}</span>　<span class="zhwrap">${esc(c[1])}</span></li>`).join('')}</ul></section>`);
    if (w.forms) out.push(`<section class="sec"><h3>詞形變化${aiTag(w, '詞形變化')}</h3><div lang="en">${esc(w.forms)}</div></section>`);
    if (w.root) {
      const rel = (w.rel || []).map((r) => `<div style="margin-top:8px"><div class="hint">同樣有 <b lang="en">${esc(r.m)}</b>（${esc(r.z)}）${r.n > r.ids.length ? `，共 ${r.n} 個，先列 ${r.ids.length} 個` : ''}</div><div class="chips">${r.ids.map((id) => BYID[id] ? `<button class="chip" type="button" data-act="peek" data-id="${id}">${esc(BYID[id].w)}</button>` : '').join('')}</div></div>`).join('');
      out.push(`<section class="sec"><h3>字根・字首・字尾${aiTag(w, '字根字首字尾')}</h3><div lang="en">${esc(w.root.text)}</div>${rel}</section>`);
    }
    if (w.book && w.book.length) out.push(`<section class="sec"><h3>書上補充</h3><ul>${w.book.map((b) => `<li><span class="k">${esc(b.k)}</span>${esc(b.v)} <span class="msrc">〔${esc(b.s)}〕</span></li>`).join('')}</ul></section>`);
    const vf = VF[w.vf.s] || ['', ''];
    out.push(`<section class="sec"><h3>主題・出處・查證</h3><dl class="kv"><dt>主題</dt><dd>${esc(w.theme || '—')}${aiTag(w, '主題分類')}</dd><dt>出處</dt><dd>${w.refs.map((r) => esc(r.label)).join('<br>')}</dd><dt>音標</dt><dd class="vf"><span class="st ${vf[1]}">${vf[0]}</span>　${esc(w.vf.n)}</dd><dt>編號</dt><dd>${w.id}</dd></dl></section>`);
    out.push(`<section class="sec"><h3>詞典（需網路，可聽真人發音）</h3><div class="dict">${dictLinks(w).map((d) => `<a href="${d[1]}" target="_blank" rel="noopener">${esc(d[0])}</a>`).join('')}</div></section>`);
    return `<div class="details">${out.join('')}</div>`;
  }
  function voiceBanner() {
    if (!TTS.ready || TTS.hasEnglish()) return '';
    return `<div class="banner"><b>這台裝置找不到英文語音</b>為了不讓其他語言的聲音念英文，目前不播放發音。iPhone：設定 › 輔助使用 › 朗讀內容 › 聲音 › 英文，下載一個英文語音。Android：在設定搜尋「文字轉語音」，安裝或選擇英文語音。裝好後重新開啟 App。現在可以先點卡片下方的詞典連結聽真人發音。</div>`;
  }

  // ---------------- toast & sheet ----------------
  let toastTimer = null;
  function toast(msg, ms) {
    let el = $('#toast'); if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.textContent = msg; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, ms || 2200);
  }
  function openSheet(title, bodyHTML, footHTML, onMount) {
    closeSheet();
    const bg = document.createElement('div'); bg.className = 'sheet-bg'; bg.id = 'sheet';
    bg.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="sheet-h"><b>${esc(title)}</b><button class="btn small" type="button" data-close>關閉</button></div><div class="sheet-b">${bodyHTML}</div>${footHTML ? `<div class="sheet-f">${footHTML}</div>` : ''}</div>`;
    bg.addEventListener('click', (e) => { if (e.target === bg || e.target.closest('[data-close]')) closeSheet(); });
    document.body.appendChild(bg);
    if (onMount) onMount(bg);
  }
  function closeSheet() { const s = $('#sheet'); if (s) s.remove(); }
  function peek(id) {
    const w = BYID[id]; if (!w) return;
    openSheet(w.w, cardHTML(w, { showZh: true }) + detailsHTML(w), '<button class="btn primary" type="button" data-act="peeksay">▶ 播放發音</button>', (el) => {
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-act]'); if (!b) return;
        if (b.dataset.act === 'peeksay') TTS.speak(w.say);
        if (b.dataset.act === 'sayex') TTS.speak(w.ex[+b.dataset.i].en);
        if (b.dataset.act === 'peek') peek(b.dataset.id);
      });
    });
    if (S.settings.autoplay) TTS.speak(w.say, false, true);
  }

  // ---------------- views ----------------
  const main = () => $('#main'); const bar = () => $('#bar');
  function setTabs() { document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === S.view))); }
  function render() {
    setTabs(); closeSheet();
    if (S.view === 'home') renderHome();
    else if (S.view === 'cards') renderCards();
    else if (S.view === 'review') renderReview();
    else if (S.view === 'quiz') renderQuiz();
    else if (S.view === 'search') renderSearch();
    else renderSettings();
  }


  // ---- cover / home ----
  const SRC_TILES = [['all', '全部單字'], ['課本', '課本'], ['雜誌', '雜誌'], ['核心', '核心單字'], ['成功閱讀', '成功閱讀'], ['學測翻譯', '學測翻譯'], ['multi', '多個來源都有']];
  let hf = null; // draft filter on the cover
  function srcCount(src, sub) { return WORDS.filter((w) => matchFilter(w, { src, sub: sub || [], pos: [], theme: [], mark: 'all' })).length; }
  function renderHome() {
    if (!hf) hf = { src: S.filter.src, sub: (S.filter.sub || []).slice() };
    const subs = {};
    for (const w of WORDS) for (const r of w.refs) (subs[r.src] = subs[r.src] || new Set()).add(subKey(r));
    const subList = SRC_ORDER.includes(hf.src) ? Array.from(subs[hf.src] || []).sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1))) : [];
    const subName = { '課本': '選課別', '雜誌': '選單元', '核心': '選 Unit', '成功閱讀': '選 Unit', '學測翻譯': '選 Unit' }[hf.src];
    const n = srcCount(hf.src, hf.sub);
    const due = WORDS.filter((w) => S.srs[w.id] && S.srs[w.id].due <= today()).length;
    const resumeKey = filterKey(S.filter) + '|' + S.order;
    const resumeAt = S.pos[resumeKey] || 0;
    main().innerHTML = voiceBanner() + `<section class="cover">
        <div class="cover-mark" aria-hidden="true"><span>A</span><span>a</span></div>
        <h2 class="cover-title">第二次段考<br>英文單字卡</h2>
        <p class="cover-sub">戰勝加考　戰勝段考！</p>
        <div class="cover-stats"><span><b>${WORDS.length}</b> 張卡</span><span><b>${due}</b> 個字今天要複習</span><span><b>${Object.values(S.marks).filter((m) => m === 'again').length}</b> 個再複習</span></div>
      </section>
      <section class="pick">
        <h3>選擇單字來源</h3>
        <div class="tiles">${SRC_TILES.map(([v, l]) => `<button type="button" class="tile" data-hsrc="${esc(v)}" aria-pressed="${hf.src === v}"><span class="tl">${esc(l)}</span><span class="tn">${srcCount(v)} 字</span></button>`).join('')}</div>
        ${subList.length ? `<div class="subpick"><span class="lbl">${subName}（不選＝全部）</span><div class="seg">${subList.map((x) => `<button type="button" data-hsub="${esc(x)}" aria-pressed="${hf.sub.includes(x)}">${esc(x)}</button>`).join('')}</div></div>` : ''}
        ${resumeAt > 0 ? `<button type="button" class="linkbtn" data-act="resume">繼續上次：${esc(filterLabel(S.filter))}，第 ${resumeAt + 1} 個</button>` : ''}
      </section>
      <p class="updated">最新更新：${esc(DATA.updated || DATA.version)}</p>${DATA.changes ? `<p class="changes">本次更新：${esc(DATA.changes)}</p>` : ''}`;
    bar().innerHTML = `<div class="row2"><button class="btn big" type="button" data-act="homereview">今日複習${due ? `（${due}）` : ''}</button><button class="btn primary big" type="button" data-act="homestart" ${n ? '' : 'disabled'}>開始背 ${n} 個字</button></div>`;
    main().scrollTop = 0;
  }

  // ---- cards ----
  let curList = [];
  function curIndex() { const i = S.pos[posKey()] || 0; return Math.max(0, Math.min(i, curList.length)); }
  function renderCards(noSpeak) {
    curList = listFor(S.filter, S.order);
    const i = curIndex(); const n = curList.length;
    const head = `${voiceBanner()}<div class="toolbar"><button class="chipbtn grow" type="button" data-act="filter" aria-label="篩選">篩選：${esc(filterLabel(S.filter))}</button><button class="chipbtn" type="button" data-act="order">${S.order === 'rand' ? '隨機順序' : '原始順序'}</button></div>`;
    if (!n) {
      main().innerHTML = head + `<div class="card empty">這個篩選沒有單字。<br><button class="btn" style="margin-top:12px" type="button" data-act="resetfilter">回到全部單字</button></div>`;
      bar().innerHTML = ''; return;
    }
    if (i >= n) { // completion screen
      const again = curList.filter((w) => S.marks[w.id] === 'again').length;
      main().innerHTML = head + `<div class="card done"><div class="hint">${esc(filterLabel(S.filter))}</div><div class="big">完成 ${n} 個單字</div><div>再複習 ${again} 個・已熟悉 ${curList.filter((w) => S.marks[w.id] === 'known').length} 個</div><div class="stack"><button class="btn primary big" type="button" data-act="restart">重新開始</button><button class="btn big" type="button" data-act="onlyagain" ${again ? '' : 'disabled'}>只複習「再複習」的字（${again}）</button><button class="btn big" type="button" data-act="shuffleagain">換一個隨機順序再來一次</button></div></div>`;
      bar().innerHTML = `<div class="row3"><button class="btn big" type="button" data-act="prev">◀ 上一個</button><button class="btn big" type="button" disabled>▶ 播放發音</button><button class="btn big" type="button" disabled>下一個 ▶</button></div>`;
      return;
    }
    const w = curList[i];
    main().innerHTML = head + `<div class="toolbar"><span class="count">第 ${i + 1}／${n}</span><span class="grow"></span><button class="chipbtn" type="button" data-act="slow" aria-pressed="${S.settings.rate === 'slow'}">${S.settings.rate === 'slow' ? '慢速 ✓' : '慢速'}</button></div>` + cardHTML(w) + detailsHTML(w);
    main().scrollTop = 0;
    const mk = S.marks[w.id];
    bar().innerHTML = `<div class="row3"><button class="btn again" type="button" data-act="again" aria-pressed="${mk === 'again'}">再複習</button><button class="btn known" type="button" data-act="known" aria-pressed="${mk === 'known'}">已熟悉</button><button class="btn hidezh" type="button" data-act="hidezh" aria-pressed="${S.settings.hideZh}">${S.settings.hideZh ? '顯示中文' : '隱藏中文'}</button></div>
      <div class="row3"><button class="btn big" type="button" data-act="prev" ${i === 0 ? 'disabled' : ''}>◀ 上一個</button><button class="btn primary big" type="button" data-act="say">▶ 播放發音</button><button class="btn big" type="button" data-act="next">下一個 ▶</button></div>`;
    if (!noSpeak && S.settings.autoplay && userActed) TTS.speak(w.say, false, true);
  }
  function go(delta) {
    TTS.stop();
    const k = posKey(); const n = curList.length;
    S.pos[k] = Math.max(0, Math.min((S.pos[k] || 0) + delta, n)); save(); renderCards();
  }
  function curWord() { return curList[curIndex()]; }

  function openFilter() {
    let f = JSON.parse(JSON.stringify(S.filter));
    const themes = Array.from(new Set(WORDS.map((w) => w.theme).filter(Boolean)));
    const subs = {};
    for (const w of WORDS) for (const r of w.refs) { (subs[r.src] = subs[r.src] || new Set()).add(subKey(r)); }
    const subSorted = (s) => Array.from(subs[s] || []).sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
    const subLabel = { '課本': '課別', '雜誌': `期數：${esc((WORDS.find((w) => w.refs.some((r) => r.src === '雜誌')) || { refs: [{}] }).refs.find((r) => r.src === '雜誌')?.issue || '')}　單元`, '核心': 'Level 3　Unit', '成功閱讀': 'Unit', '學測翻譯': 'Unit' };
    const draw = (el) => {
      const cnt = WORDS.filter((w) => matchFilter(w, f)).length;
      const segBtn = (grp, val, label, on) => `<button type="button" data-g="${grp}" data-v="${esc(val)}" aria-pressed="${on}">${esc(label)}</button>`;
      let h = `<div class="form"><div class="field"><span class="lbl">來源</span><div class="seg">${[['all', '全部'], ['課本', '課本'], ['雜誌', '雜誌'], ['核心', '核心單字'], ['成功閱讀', '成功閱讀'], ['學測翻譯', '學測翻譯'], ['multi', '多個來源都有']].map(([v, l]) => segBtn('src', v, l, f.src === v)).join('')}</div></div>`;
      if (SRC_ORDER.includes(f.src)) h += `<div class="field"><span class="lbl">${subLabel[f.src]}（不選＝全部）</span><div class="seg">${subSorted(f.src).map((s) => segBtn('sub', s, s, f.sub.includes(s))).join('')}</div></div>`;
      h += `<div class="field"><span class="lbl">詞性（可複選）</span><div class="seg">${Object.entries(POS_NAMES).map(([k, v]) => segBtn('pos', k, v, f.pos.includes(k))).join('')}</div></div>`;
      h += `<div class="field"><span class="lbl">主題（可複選）</span><div class="seg">${themes.map((t) => segBtn('theme', t, t, f.theme.includes(t))).join('')}</div></div>`;
      h += `<div class="field"><span class="lbl">標記</span><div class="seg">${[['all', '全部'], ['again', '再複習'], ['known', '已熟悉'], ['none', '未標記']].map(([v, l]) => segBtn('mark', v, l, f.mark === v)).join('')}</div></div></div>`;
      el.querySelector('.sheet-b').innerHTML = h;
      el.querySelector('[data-act="applyf"]').textContent = `套用（${cnt} 個單字）`;
    };
    openSheet('篩選單字', '', '<div class="row2"><button class="btn" type="button" data-act="clearf">清除篩選</button><button class="btn primary" type="button" data-act="applyf">套用</button></div>', (el) => {
      draw(el);
      el.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.g) {
          const g = b.dataset.g, v = b.dataset.v;
          if (g === 'src') { f.src = v; f.sub = []; }
          else if (g === 'mark') f.mark = v;
          else { const arr = f[g]; const k = arr.indexOf(v); if (k >= 0) arr.splice(k, 1); else arr.push(v); }
          draw(el);
        } else if (b.dataset.act === 'clearf') { f = defaultFilter(); draw(el); }
        else if (b.dataset.act === 'applyf') { S.filter = f; save(); closeSheet(); renderCards(); }
      });
    });
  }

  // ---- review (spaced repetition) ----
  let rvShow = false;
  function buildToday(extraNew) {
    const d = today();
    const scope = S.settings.reviewScope === 'filter' ? listFor(S.filter, 'orig') : WORDS;
    if (!S.today || S.today.d !== d) S.today = { d, queue: [], done: 0, newIds: [], remembered: 0, forgot: 0 };
    const T = S.today;
    if (!extraNew) {
      const due = WORDS.filter((w) => S.srs[w.id] && S.srs[w.id].due <= d && !T.queue.includes(w.id)).sort((a, b) => S.srs[a.id].due.localeCompare(S.srs[b.id].due));
      for (const w of due) T.queue.push(w.id);
    }
    const want = extraNew || Math.max(0, S.settings.newPerDay - T.newIds.length);
    let added = 0;
    for (const w of scope) {
      if (added >= want) break;
      if (!S.srs[w.id] && !T.queue.includes(w.id) && !T.newIds.includes(w.id)) { T.queue.push(w.id); T.newIds.push(w.id); added++; }
    }
    save();
  }
  function renderReview() {
    if (!S.today || S.today.d !== today()) buildToday();
    else if (S.today.newIds.length < S.settings.newPerDay) buildToday();
    const T = S.today;
    const dueLeft = T.queue.length;
    const stat = `<div class="rv-stat"><div><b>${dueLeft}</b><span>今天還要複習</span></div><div><b>${T.remembered}</b><span>記得</span></div><div><b>${T.forgot}</b><span>不記得</span></div></div>`;
    if (!dueLeft) {
      const tomorrow = WORDS.filter((w) => S.srs[w.id] && S.srs[w.id].due === today(1)).length;
      main().innerHTML = voiceBanner() + stat + `<div class="card done"><div class="big">今天的複習完成了</div><div>明天預計複習 ${tomorrow} 個字。</div><div class="stack"><button class="btn primary big" type="button" data-act="morenew">再學 ${S.settings.newPerDay} 個新字</button><button class="btn big" type="button" data-view="cards">回到單字卡</button></div><p class="hint" style="margin-top:14px">記得的字會在 1、3、7、14、30 天後再出現；不記得的字今天會再出現一次。每日新字數可在「設定」調整。</p></div>`;
      bar().innerHTML = ''; return;
    }
    const w = BYID[T.queue[0]];
    if (!w) { T.queue.shift(); save(); return renderReview(); }
    const st = S.srs[w.id];
    const kind = !st ? '新字' : (st.b === 0 ? '再一次' : `第 ${st.b} 輪複習`);
    if (!rvShow) {
      main().innerHTML = voiceBanner() + stat + `<div class="card"><div class="srcline"><span class="src">${kind}</span></div><div class="word${longWord(w) ? ' long' : ''}" lang="en">${esc(w.w)}</div><div class="phon"><span><span class="lab">KK</span>[${esc(w.kk)}]</span></div><p class="hint" style="margin-top:14px">先在心裡想它的意思，再按「顯示答案」。</p></div>`;
      bar().innerHTML = `<div class="row2"><button class="btn big" type="button" data-act="rvsay">▶ 播放發音</button><button class="btn primary big" type="button" data-act="rvshow">顯示答案</button></div>`;
      if (S.settings.autoplay && userActed) TTS.speak(w.say, false, true);
    } else {
      main().innerHTML = voiceBanner() + stat + cardHTML(w, { showZh: true });
      bar().innerHTML = `<div class="row3"><button class="btn big" type="button" data-act="rvsay">▶ 發音</button><button class="btn big" type="button" data-act="rvno">不記得</button><button class="btn primary big" type="button" data-act="rvyes">記得</button></div>`;
    }
    main().scrollTop = 0;
  }
  function rvAnswer(ok) {
    const T = S.today; const id = T.queue.shift(); const d = today();
    const st = S.srs[id] || { b: 0, due: d, n: 0 };
    st.n = (st.n || 0) + 1; st.last = d;
    if (ok) { st.b = Math.min((st.b || 0) + 1, INTERVALS.length); st.due = addDays(d, INTERVALS[st.b - 1]); T.remembered++; }
    else { st.b = 0; st.due = d; T.queue.push(id); T.forgot++; S.marks[id] = 'again'; }
    S.srs[id] = st; T.done++; rvShow = false; TTS.stop(); save(); renderReview();
  }

  // ---- quiz ----
  let Q = null;
  const QTYPES = [['en2zh', '看英文選中文'], ['au2zh', '聽發音選中文'], ['zh2en', '看中文選英文'], ['spell', '拼字題（字頭字尾／例句挖空）'], ['cloze', '例句填空']];
  const ALLQ = QTYPES.map((x) => x[0]);
  let qset = { n: 10, scope: 'filter' };
  function qtypes() { const t = (S.settings.qtypes || ALLQ).filter((x) => ALLQ.includes(x)); return t; }
  function zhOf(w) { return w.m.map((m) => m.p + ' ' + m.z).slice(0, 2).join('；'); }
  function clozeOf(w) {
    if (!w.hl) return null;
    for (const x of w.ex) { let rx; try { rx = new RegExp(w.hl, 'i'); } catch (e) { return null; } const m = rx.exec(x.en); if (m) return { text: x.en.slice(0, m.index) + '_____' + x.en.slice(m.index + m[0].length), ans: m[0], zh: x.zh }; }
    return null;
  }
  // 拼字題提示：每個字只給字頭和字尾，中間挖空（3 個字母以內的小字整個給）
  function letterPattern(ans, isPhrase) {
    return ans.split(' ').map((t) => {
      const L = t.replace(/[^A-Za-z]/g, '').length;
      if (isPhrase && L <= 3) return esc(t);
      const idx = []; for (let i = 0; i < t.length; i++) if (/[A-Za-z]/.test(t[i])) idx.push(i);
      const first = idx[0], last = idx[idx.length - 1];
      return [...t].map((ch, i) => {
        if (!/[A-Za-z]/.test(ch)) return esc(ch);
        if (i === first || (i === last && L > 3)) return esc(ch);
        return '_';
      }).join(' ');
    }).join('&nbsp;&nbsp;&nbsp;');
  }
  function spellSentence(w) {
    const c = clozeOf(w); if (!c) return null;
    if (/\s/.test(c.ans) !== /\s/.test(w.w.trim())) return null;
    return c;
  }
  function spellable(w) { return !/[\/…]|\.\.\.|\bsb\b|\bsth\b|one's/.test(w.w); }
  function makeQuiz(ids) {
    let pool;
    if (ids) pool = ids.map((id) => BYID[id]).filter(Boolean);
    else {
      pool = qset.scope === 'again' ? WORDS.filter((w) => S.marks[w.id] === 'again') : listFor(S.filter, 'orig');
      const r = rng(Date.now() & 0xffffffff); pool = pool.slice(); for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    }
    const qs = [];
    const types = ALLQ.filter((x) => qtypes().includes(x));
    const fits = (t, w) => (t !== 'cloze' || clozeOf(w)) && (t !== 'spell' || spellable(w));
    let turn = 0;
    for (const w of pool) {
      if (!ids && qs.length >= qset.n) break;
      // 依勾選的題型輪流出題；這個字不適合輪到的題型時，改用下一個勾選的題型
      let t = null;
      for (let k = 0; k < types.length; k++) { const c = types[(turn + k) % types.length]; if (fits(c, w)) { t = c; break; } }
      if (!t) continue;
      turn++;
      const q = { id: w.id, t, sub: t === 'spell' ? ((qs.length % 2 === 0 && spellSentence(w)) ? 'sent' : 'zh') : '' };
      if (t === 'en2zh' || t === 'au2zh' || t === 'zh2en' || t === 'cloze') q.opts = distractors(w, t);
      if (t === 'spell') q.ans = q.sub === 'sent' ? spellSentence(w).ans : w.w;
      qs.push(q);
    }
    Q = { qs, i: 0, score: 0, wrong: [], answered: false, picked: null };
  }
  function distractors(w, t) {
    const same = WORDS.filter((x) => x.id !== w.id && x.cat.some((c) => w.cat.includes(c)) && zhOf(x) !== zhOf(w) && x.w.toLowerCase() !== w.w.toLowerCase());
    const pool = same.length >= 3 ? same : WORDS.filter((x) => x.id !== w.id);
    const r = rng((Date.now() ^ hashStr(w.id)) >>> 0); const pick = new Set();
    while (pick.size < 3 && pick.size < pool.length) pick.add(pool[Math.floor(r() * pool.length)].id);
    const ids = [w.id, ...pick]; for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
    return ids;
  }
  function renderQuiz() {
    if (!Q) {
      main().innerHTML = voiceBanner() + `<div class="card"><div class="form">
        <div class="field"><span class="lbl">題型（可複選，選多種會輪流出題）</span><div class="seg">${QTYPES.map(([k, l]) => `<button type="button" data-q="qt" data-v="${k}" aria-pressed="${qtypes().includes(k)}">${qtypes().includes(k) ? '✓ ' : ''}${l}</button>`).join('')}</div><div class="row2" style="margin-top:8px"><button class="btn small" type="button" data-q="qtall">全選</button><button class="btn small" type="button" data-q="qtnone">全部取消</button></div>${qtypes().length ? '' : '<div class="hint" style="margin-top:6px">請至少選一種題型。</div>'}</div>
        <div class="field"><span class="lbl">題數</span><div class="seg">${[10, 20, 30].map((n) => `<button type="button" data-q="n" data-v="${n}" aria-pressed="${qset.n === n}">${n} 題</button>`).join('')}</div></div>
        <div class="field"><span class="lbl">範圍</span><div class="seg"><button type="button" data-q="scope" data-v="filter" aria-pressed="${qset.scope === 'filter'}">目前篩選（${listFor(S.filter, 'orig').length}）</button><button type="button" data-q="scope" data-v="again" aria-pressed="${qset.scope === 'again'}">只考再複習（${WORDS.filter((w) => S.marks[w.id] === 'again').length}）</button></div><div class="hint" style="margin-top:6px">目前篩選：${esc(filterLabel(S.filter))}</div></div>
        <p class="hint">答錯的字會自動加入「再複習」。</p></div></div>`;
      bar().innerHTML = `<button class="btn primary big" type="button" data-act="qstart" ${qtypes().length ? '' : 'disabled'}>開始測驗（${qtypes().length} 種題型）</button>`;
      return;
    }
    if (Q.i >= Q.qs.length) {
      const pct = Q.qs.length ? Math.round(Q.score / Q.qs.length * 100) : 0;
      main().innerHTML = `<div class="card done"><div class="hint">測驗結束</div><div class="big">${Q.score}／${Q.qs.length}（${pct} 分）</div>${Q.wrong.length ? `<div style="text-align:left;margin-top:12px"><div class="hint">答錯的字（已加入再複習）</div><div class="chips" style="margin-top:6px">${Q.wrong.map((id) => `<button class="chip" type="button" data-act="peek" data-id="${id}">${esc(BYID[id].w)}</button>`).join('')}</div></div>` : '<div>全對！</div>'}<div class="stack"><button class="btn primary big" type="button" data-act="qretry" ${Q.wrong.length ? '' : 'disabled'}>只重測答錯的字（${Q.wrong.length}）</button><button class="btn big" type="button" data-act="qnew">再做一次新測驗</button></div></div>`;
      bar().innerHTML = ''; return;
    }
    const q = Q.qs[Q.i]; const w = BYID[q.id];
    let body = '', prompt = '';
    if (q.t === 'en2zh') { prompt = '這個英文是什麼意思？'; body = `<div class="qbody en" lang="en">${esc(w.w)}</div>`; }
    if (q.t === 'au2zh') { prompt = '聽發音，選出正確的中文'; body = `<button class="btn primary big" type="button" data-act="qsay" style="width:100%">▶ 再聽一次</button>`; }
    if (q.t === 'zh2en') { prompt = '選出符合中文的英文'; body = `<div class="qbody">${esc(zhOf(w))}</div>`; }
    if (q.t === 'cloze') { const c = clozeOf(w); prompt = '選出填入空格的字（不需變化形）'; body = `<div class="qbody" lang="en" style="font-family:var(--font-word)">${esc(c.text)}</div><div class="hint" style="margin-top:6px">${esc(c.zh)}</div>`; }
    let spellAns = w.w;
    if (q.t === 'spell') {
      if (q.sub === 'sent') {
        const c = spellSentence(w); spellAns = q.ans || c.ans;
        prompt = '在空格中拼出正確的字（注意字形變化）';
        body = `<div class="qbody" lang="en" style="font-family:var(--font-word)">${esc(c.text)}</div><div class="hint" style="margin-top:6px">${esc(c.zh)}</div><div class="spellhint" lang="en">${letterPattern(c.ans, /\s/.test(c.ans))}</div>`;
      } else {
        prompt = '看中文，拼出這個字';
        body = `<div class="qbody">${esc(zhOf(w))}</div><div class="spellhint" lang="en">${letterPattern(w.w, /\s/.test(w.w.trim()))}</div>`;
      }
    }
    let ans = '';
    if (q.opts) {
      ans = `<div class="opts">${q.opts.map((id) => { const o = BYID[id]; const label = (q.t === 'zh2en' || q.t === 'cloze') ? o.w : zhOf(o); let cls = 'opt' + ((q.t === 'zh2en' || q.t === 'cloze') ? ' en' : ''); if (Q.answered) { if (id === q.id) cls += ' right'; else if (id === Q.picked) cls += ' wrong'; } return `<button class="${cls}" type="button" data-act="qpick" data-id="${id}" ${Q.answered ? 'disabled' : ''}>${esc(label)}</button>`; }).join('')}</div>`;
    } else {
      ans = `<form class="spell" id="spellForm" autocomplete="off"><input id="spellInput" lang="en" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="輸入拼字" ${Q.answered ? 'disabled' : ''}><button class="btn primary" type="submit" ${Q.answered ? 'disabled' : ''}>送出</button></form>`;
    }
    let fb = '';
    if (Q.answered) fb = `<div class="feedback">${Q.lastOk ? '<span class="r">答對了！</span>' : '<span class="w">答錯了。</span>'} 正確答案：<b lang="en">${esc(q.t === 'spell' ? spellAns : w.w)}</b>${q.t === 'spell' && spellAns.toLowerCase() !== w.w.toLowerCase() ? `（原形 ${esc(w.w)}）` : ''}　${esc(zhOf(w))}</div>`;
    main().innerHTML = `<div class="toolbar"><span class="count">第 ${Q.i + 1}／${Q.qs.length} 題・得分 ${Q.score}</span><span class="grow"></span><button class="chipbtn" type="button" data-act="qquit">結束</button></div><div class="card"><div class="qprompt">${prompt}</div>${body}${ans}${fb}</div>`;
    bar().innerHTML = Q.answered ? `<div class="row2"><button class="btn big" type="button" data-act="qsayw">▶ 發音</button><button class="btn primary big" type="button" data-act="qnext">下一題</button></div>` : '';
    if (!Q.answered && q.t === 'au2zh') TTS.speak(w.say, false, true);
    const f = $('#spellForm'); if (f) { f.addEventListener('submit', (e) => { e.preventDefault(); const v = $('#spellInput').value; qAnswer(norm(v) === norm(spellAns)); }); if (!Q.answered) setTimeout(() => { const i = $('#spellInput'); if (i) i.focus(); }, 50); }
  }
  function norm(s) { return String(s).toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim(); }
  function qAnswer(ok, picked) {
    const q = Q.qs[Q.i]; Q.answered = true; Q.lastOk = ok; Q.picked = picked || null;
    if (ok) Q.score++; else { if (!Q.wrong.includes(q.id)) Q.wrong.push(q.id); S.marks[q.id] = 'again'; save(); }
    renderQuiz();
  }

  // ---- search ----
  let searchQ = '';
  function renderSearch() {
    main().innerHTML = `<input class="searchbox" id="searchInput" type="search" placeholder="輸入英文或中文，例如 detect、偵測" value="${esc(searchQ)}" aria-label="搜尋單字"><div class="results" id="results"></div>`;
    bar().innerHTML = '';
    const inp = $('#searchInput'); inp.addEventListener('input', () => { searchQ = inp.value; drawResults(); }); drawResults();
  }
  function drawResults() {
    const q = searchQ.trim().toLowerCase(); const el = $('#results'); if (!el) return;
    if (!q) { el.innerHTML = `<div class="hint">共 ${WORDS.length} 個單字。可以用英文（含片語）或中文意思搜尋。</div>`; return; }
    const hits = [];
    for (const w of WORDS) {
      const ww = w.w.toLowerCase(); let sc = -1;
      if (ww === q) sc = 0; else if (ww.startsWith(q)) sc = 1; else if (ww.includes(q)) sc = 2;
      else if (w.m.some((m) => m.z.includes(searchQ.trim()))) sc = 3;
      else if (w.forms && w.forms.toLowerCase().includes(q) && /^[a-z]/.test(q)) sc = 4;
      if (sc >= 0) hits.push([sc, w]);
    }
    hits.sort((a, b) => a[0] - b[0] || a[1].w.length - b[1].w.length);
    el.innerHTML = hits.length ? hits.slice(0, 60).map(([, w]) => `<button class="res" type="button" data-act="peek" data-id="${w.id}"><span class="en" lang="en">${esc(w.w)}</span><span class="z">${esc(zhOf(w))}</span></button>`).join('') + (hits.length > 60 ? `<div class="hint">另有 ${hits.length - 60} 筆，請輸入更完整的字。</div>` : '') : '<div class="hint">找不到符合的單字。</div>';
  }

  // ---- settings ----
  let confirmClear = false, restoreOpen = false;
  function refreshVoiceUI() { if (S.view === 'settings' && !$('#sheet')) renderSettings(); else if (S.view === 'cards' && TTS.ready && !TTS.hasEnglish() && !$('.banner')) { /* show banner once voices known */ if (curList.length) renderCards(true); } }
  function renderSettings() {
    const st = S.settings;
    const vs = TTS.voices.slice().sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
    const voiceSel = TTS.hasEnglish() ? `<select class="sel" id="voiceSel"><option value="">自動選擇（依上方口音）</option>${vs.map((v) => `<option value="${esc(v.voiceURI)}" ${st.voiceURI === v.voiceURI ? 'selected' : ''}>${esc(v.name)}（${esc(v.lang)}${v.localService ? '・本機' : '・需網路'}）</option>`).join('')}</select>` : `<div class="banner" style="margin:0"><b>找不到英文語音</b>iPhone：設定 › 輔助使用 › 朗讀內容 › 聲音 › 英文，下載一個英文語音（例如 Samantha）。Android：在設定搜尋「文字轉語音」，把引擎的語言設為英文並下載語音資料。裝好後重新開啟 App。</div>`;
    const seg = (key, vals) => `<div class="seg">${vals.map(([v, l]) => `<button type="button" data-set="${key}" data-v="${v}" aria-pressed="${String(st[key]) === String(v)}">${l}</button>`).join('')}</div>`;
    const pwa = APP.mode === 'pwa';
    main().innerHTML = `<div class="form">
      <section class="sec"><h3>語音</h3><div class="form">
        <div class="field"><span class="lbl">口音</span>${seg('accent', [['en-US', '美式'], ['en-GB', '英式']])}</div>
        <div class="field"><label for="voiceSel">個別語音</label>${voiceSel}</div>
        <div class="field"><span class="lbl">速度</span>${seg('rate', [['normal', '正常'], ['slow', '慢速']])}</div>
        <div class="field"><span class="lbl">換字時自動播放</span>${seg('autoplay', [['true', '開'], ['false', '關']])}</div>
        <button class="btn" type="button" data-act="testvoice">▶ 試聽：The quick brown fox jumps over the lazy dog.</button>
        ${!TTS.supported ? '<div class="hint">這個瀏覽器不支援語音朗讀。</div>' : ''}
      </div></section>
      <section class="sec"><h3>今日複習</h3><div class="form">
        <div class="field"><span class="lbl">每日新字數</span>${seg('newPerDay', [[5, '5'], [10, '10'], [15, '15'], [20, '20'], [30, '30']])}</div>
        <div class="field"><span class="lbl">新字從哪裡選</span>${seg('reviewScope', [['all', '全部單字'], ['filter', '目前篩選']])}</div>
      </div></section>
      <section class="sec"><h3>外觀</h3>${seg('theme', [['system', '跟隨系統'], ['light', '淺色'], ['dark', '深色']])}</section>
      <section class="sec"><h3>${pwa ? '離線使用' : '儲存與同步'}</h3><div class="form">
        ${pwa ? `<div class="statusline" id="offlineStatus"><span class="dot"></span><span>檢查中…</span></div>` : `<div class="statusline"><span class="dot ${Cloud.ok ? 'on' : ''}"></span><span>${esc(Cloud.label || '進度存在這個瀏覽器')}</span></div>`}
        <div class="row2"><button class="btn" type="button" data-act="copyprog">複製進度</button><button class="btn" type="button" data-act="restoreprog">還原進度</button></div>
        ${restoreOpen ? `<div class="field"><label for="restoreText">貼上之前複製的進度文字</label><textarea class="ta" id="restoreText"></textarea><div class="row2" style="margin-top:8px"><button class="btn" type="button" data-act="restorecancel">取消</button><button class="btn primary" type="button" data-act="restoredo">還原</button></div></div>` : ''}
        <textarea class="ta" id="copyText" hidden readonly></textarea>
        ${confirmClear ? `<div class="banner"><b>確定要清除所有進度嗎？</b>標記、複習排程、位置和設定都會刪除，無法復原。建議先按「複製進度」備份。<div class="row2" style="margin-top:10px"><button class="btn" type="button" data-act="clearno">取消</button><button class="btn primary" type="button" data-act="clearyes">確定清除</button></div></div>` : `<button class="btn" type="button" data-act="clearprog">清除進度</button>`}
      </div></section>
      <section class="sec"><h3>關於</h3><dl class="kv"><dt>單字數</dt><dd>${WORDS.length} 張卡</dd><dt>最新更新</dt><dd>${esc(DATA.updated || DATA.version)}</dd><dt>資料版本</dt><dd>${esc(DATA.version)}</dd><dt>標記</dt><dd>再複習 ${Object.values(S.marks).filter((m) => m === 'again').length}・已熟悉 ${Object.values(S.marks).filter((m) => m === 'known').length}</dd><dt>說明</dt><dd>標「AI 補寫」的內容不是教材原文。音標以 CMU 發音辭典核對；標「待確認」的請以詞典為準。發現錯字請告訴老師。</dd></dl></section>
    </div>`;
    bar().innerHTML = '';
    const vsel = $('#voiceSel'); if (vsel) vsel.addEventListener('change', () => { S.settings.voiceURI = vsel.value; save(); TTS.speak('Hello! This is my voice.'); });
    if (pwa) offlineStatus();
  }
  async function offlineStatus() {
    const el = $('#offlineStatus'); if (!el) return;
    let ok = false, msg = '尚未下載：請連上網路開啟一次，等幾秒後重新開啟。';
    try {
      if ('serviceWorker' in navigator && 'caches' in window) {
        const names = await caches.keys(); const name = names.find((n) => n === window.VOCAB_CACHE);
        if (name) { const c = await caches.open(name); const keys = await c.keys(); const need = (window.VOCAB_FILES || []).length; if (keys.length >= need && need) { ok = true; msg = '已下載到這台裝置（離線也能使用）'; } else msg = `下載中…（${keys.length}／${need}）`; }
        if (ok && !navigator.serviceWorker.controller) msg = '已下載，下次開啟時生效';
      } else msg = '這個瀏覽器不支援離線使用';
    } catch (e) { /* ignore */ }
    el.innerHTML = `<span class="dot ${ok ? 'on' : ''}"></span><span>${esc(msg)}</span>`;
  }
  function exportProgress() {
    const json = JSON.stringify({ app: 'vocab', v: 1, at: new Date().toISOString(), state: S });
    return 'VOCAB1:' + btoa(unescape(encodeURIComponent(json)));
  }
  function importProgress(txt) {
    try {
      txt = txt.trim(); if (!txt.startsWith('VOCAB1:')) throw new Error('fmt');
      const o = JSON.parse(decodeURIComponent(escape(atob(txt.slice(7)))));
      if (!o || o.app !== 'vocab') throw new Error('fmt');
      S = normalizeState(o.state); S.view = 'settings'; save(); applyTheme(); return true;
    } catch (e) { return false; }
  }

  // ---------------- events ----------------
  let userActed = false;
  function onClick(e) {
    userActed = true;
    const t = e.target;
    const tab = t.closest('.tabs button'); if (tab) { TTS.stop(); S.view = tab.dataset.view; if (S.view !== 'quiz') { /* keep quiz */ } save(); render(); return; }
    const vb = t.closest('[data-view]'); if (vb && !vb.closest('.tabs')) { S.view = vb.dataset.view; save(); render(); return; }
    if ($('#sheet') && t.closest('#sheet')) return; // handled by sheet
    const hs = t.closest('[data-hsrc]'); if (hs) { hf = { src: hs.dataset.hsrc, sub: [] }; renderHome(); return; }
    const hsub = t.closest('[data-hsub]'); if (hsub) { const k = hf.sub.indexOf(hsub.dataset.hsub); if (k >= 0) hf.sub.splice(k, 1); else hf.sub.push(hsub.dataset.hsub); renderHome(); return; }
    const hb = t.closest('[data-act="gohome"]'); if (hb) { TTS.stop(); hf = null; S.view = 'home'; render(); return; }
    const setb = t.closest('[data-set]');
    if (setb) {
      const k = setb.dataset.set; let v = setb.dataset.v;
      if (k === 'autoplay') v = v === 'true'; else if (k === 'newPerDay') v = +v;
      S.settings[k] = v; if (k === 'accent') S.settings.voiceURI = '';
      if (k === 'newPerDay' && S.today && S.today.d === today()) { /* new limit applies when review opens */ }
      save(); if (k === 'theme') applyTheme(); renderSettings(); return;
    }
    const qb = t.closest('[data-q]'); if (qb) {
      const k = qb.dataset.q;
      if (k === 'qt') { const cur = qtypes().slice(); const i = cur.indexOf(qb.dataset.v); if (i >= 0) cur.splice(i, 1); else cur.push(qb.dataset.v); S.settings.qtypes = cur; save(); }
      else if (k === 'qtall') { S.settings.qtypes = ALLQ.slice(); save(); }
      else if (k === 'qtnone') { S.settings.qtypes = []; save(); }
      else qset[k] = k === 'n' ? +qb.dataset.v : qb.dataset.v;
      renderQuiz(); return;
    }
    const reveal = t.closest('[data-act="reveal"]'); if (reveal && S.settings.hideZh) { const c = reveal.closest('.card'); if (c) c.classList.remove('hidden-zh'); return; }
    const b = t.closest('[data-act]'); if (!b) return;
    const a = b.dataset.act;
    const w = S.view === 'cards' ? curWord() : null;
    switch (a) {
      case 'homestart': S.filter = Object.assign(defaultFilter(), { src: hf.src, sub: hf.sub.slice() }); S.view = 'cards'; hf = null; save(); render(); break;
      case 'resume': S.view = 'cards'; hf = null; save(); render(); break;
      case 'homereview': S.view = 'review'; hf = null; save(); render(); break;
      case 'next': go(1); break;
      case 'prev': go(-1); break;
      case 'say': if (w) TTS.speak(w.say); break;
      case 'sayex': { const card = b.closest('.card'); const ww = card ? BYID[card.dataset.id] : w; if (ww) TTS.speak(ww.ex[+b.dataset.i].en); break; }
      case 'slow': S.settings.rate = S.settings.rate === 'slow' ? 'normal' : 'slow'; save(); renderCards(true); if (w) TTS.speak(w.say); break;
      case 'again': case 'known': if (w) { S.marks[w.id] = S.marks[w.id] === a ? undefined : a; if (!S.marks[w.id]) delete S.marks[w.id]; save(); renderCards(true); } break;
      case 'hidezh': S.settings.hideZh = !S.settings.hideZh; save(); renderCards(true); break;
      case 'filter': openFilter(); break;
      case 'order': S.order = S.order === 'rand' ? 'orig' : 'rand'; save(); renderCards(); break;
      case 'resetfilter': S.filter = defaultFilter(); save(); renderCards(); break;
      case 'restart': S.pos[posKey()] = 0; save(); renderCards(); break;
      case 'onlyagain': S.filter = Object.assign({}, S.filter, { mark: 'again' }); S.pos[posKey()] = 0; save(); renderCards(); break;
      case 'shuffleagain': S.seed = Math.floor(Math.random() * 1e9); S.order = 'rand'; S.pos[posKey()] = 0; save(); renderCards(); break;
      case 'peek': peek(b.dataset.id); break;
      case 'rvshow': rvShow = true; renderReview(); break;
      case 'rvsay': { const id = S.today && S.today.queue[0]; if (id) TTS.speak(BYID[id].say); break; }
      case 'rvyes': rvAnswer(true); break;
      case 'rvno': rvAnswer(false); break;
      case 'morenew': buildToday(S.settings.newPerDay); renderReview(); break;
      case 'qstart': makeQuiz(); if (!Q.qs.length) { Q = null; toast('這個範圍沒有可以出題的單字。'); } renderQuiz(); break;
      case 'qpick': { const q = Q.qs[Q.i]; qAnswer(b.dataset.id === q.id, b.dataset.id); break; }
      case 'qnext': Q.i++; Q.answered = false; Q.picked = null; TTS.stop(); renderQuiz(); break;
      case 'qsay': case 'qsayw': TTS.speak(BYID[Q.qs[Q.i].id].say); break;
      case 'qretry': makeQuiz(Q.wrong.slice()); renderQuiz(); break;
      case 'qnew': case 'qquit': Q = null; renderQuiz(); break;
      case 'testvoice': TTS.speak('The quick brown fox jumps over the lazy dog.'); break;
      case 'copyprog': {
        const txt = exportProgress(); const ta = $('#copyText');
        const fallback = () => { ta.hidden = false; ta.value = txt; ta.focus(); ta.select(); toast('請長按上方文字框全選並複製。', 3500); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(() => toast('已複製進度。請貼到記事本或傳給自己保存。', 3000), fallback); else fallback();
        break;
      }
      case 'restoreprog': restoreOpen = true; renderSettings(); setTimeout(() => { const r = $('#restoreText'); if (r) r.focus(); }, 30); break;
      case 'restorecancel': restoreOpen = false; renderSettings(); break;
      case 'restoredo': { const ok = importProgress($('#restoreText').value); restoreOpen = !ok; toast(ok ? '已還原進度。' : '這段文字不是有效的進度備份，請重新複製。', 3000); renderSettings(); break; }
      case 'clearprog': confirmClear = true; renderSettings(); break;
      case 'clearno': confirmClear = false; renderSettings(); break;
      case 'clearyes': { const keepTheme = S.settings.theme; S = freshState(); S.settings.theme = keepTheme; S.view = 'settings'; confirmClear = false; save(); toast('已清除進度。'); render(); break; }
    }
  }
  function onKey(e) {
    if (S.view !== 'cards' || $('#sheet') || /input|textarea|select/i.test(e.target.tagName)) return;
    if (e.key === 'ArrowRight') { userActed = true; go(1); } else if (e.key === 'ArrowLeft') { userActed = true; go(-1); } else if (e.key === ' ') { e.preventDefault(); const w = curWord(); if (w) TTS.speak(w.say); }
  }

  // ---------------- boot ----------------
  async function boot() {
    const root = document.getElementById('app');
    root.innerHTML = `<header class="top"><div class="brand"><button type="button" class="homebtn" data-act="gohome" aria-label="回到封面"><h1>${esc(APP.name)}</h1><span class="homehint">封面</span></button><span class="sync" id="syncLabel"></span></div><nav class="tabs" role="tablist">${[['cards', '單字卡'], ['review', '今日複習'], ['quiz', '測驗'], ['search', '搜尋'], ['settings', '設定']].map(([v, l]) => `<button type="button" role="tab" data-view="${v}">${l}</button>`).join('')}</nav></header><main class="main" id="main"><div class="empty">載入單字中…</div></main><footer class="bar" id="bar"></footer>`;
    try {
      DATA = window.VOCAB_DATA || await fetch('words.json', { cache: 'no-cache' }).then((r) => r.json());
    } catch (e) {
      try { DATA = await fetch('words.json').then((r) => r.json()); } catch (e2) { $('#main').innerHTML = '<div class="empty">單字資料載入失敗。請連上網路後重新開啟。</div>'; return; }
    }
    WORDS = DATA.words; BYID = {}; for (const w of WORDS) BYID[w.id] = w;
    const loc = loadLocal(); if (loc) S = loc;
    S.view = 'home';
    applyTheme(); TTS.init();
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    window.addEventListener('pagehide', () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) { } Cloud.flush(); });
    render();
    Cloud.init();
    window.__vocab = { get state() { return S; }, get quiz() { return Q; }, words: () => WORDS, today, addDays, TTS, render, exportProgress };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
