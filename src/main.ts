import './style.css';
import { PARAMS as P } from './params';
import type { Grain, State, Theme } from './types';
import { loadState, saveState, exportJson, parseImportedJson } from './store';
import { cull, displayedGrains, effectiveAge, isOpenQuestion, tierOf, touch } from './ecosystem';
import { buildSampleState } from './sample';

// ---------- 状態 ----------
let state: State = loadState();
let eco = state.ecoSeconds;
let selection: string[] = [];
let currentView: 'now' | 'theme' | 'search' = 'now';
let openThemeId: string | null = null;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const elField = $('#field');
const elThread = $('#thread');
const elThreadList = $('#thread-list');
const elThreadTitle = $('#thread-title');
const elSearch = $('#search');
const elSearchInput = $<HTMLInputElement>('#search-input');
const elSearchResults = $('#search-results');
const elToolbar = $('#toolbar');
const elLauncher = $<HTMLFormElement>('#launcher');
const elLaunchInput = $<HTMLInputElement>('#launch-input');

const grainById = (id: string) => state.grains.find((g) => g.id === id);
const themeById = (id: string) => state.themes.find((t) => t.id === id);

// ---------- 生態系時刻（滞在時間でのみ進む。不在中は凍結） ----------
setInterval(() => {
  if (document.hidden || !document.hasFocus()) return;
  eco++;
  state.ecoSeconds = eco;
  if (eco % 5 === 0 && cull(state, eco)) {
    if (currentView === 'now') renderNow();
  }
  if (eco % 15 === 0) saveState(state);
  if (eco % 60 === 0 && currentView === 'now') renderNow(); // 冷えの見た目を更新
}, 1000);

window.addEventListener('beforeunload', () => {
  state.ecoSeconds = eco;
  saveState(state);
});

// タブが隠れた瞬間にも保存(モバイルやクラッシュ対策)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    state.ecoSeconds = eco;
    saveState(state);
  }
});

// ---------- 変異の共通処理 ----------
function commit(): void {
  cull(state, eco);
  saveState(state);
  render();
}

function newGrain(text: string, opts: { parents?: string[]; attachedTo?: string | null; themeId?: string | null } = {}): Grain {
  const g: Grain = {
    id: crypto.randomUUID(),
    text,
    createdAtWall: Date.now(),
    lastTouchEco: eco,
    status: 'alive',
    parentIds: opts.parents ?? [],
    attachedToId: opts.attachedTo ?? null,
    themeId: opts.themeId ?? null,
    cometReturnAtWall: null,
  };
  // 接触: 親（付箋の貼り先・追記元・合流元）の時計が巻き戻る
  for (const pid of g.parentIds) {
    const p = grainById(pid);
    if (p) touch(p, eco);
  }
  state.grains.push(g);
  return g;
}

// ---------- 操作 ----------

// 日本語IMEの変換確定Enterで誤送信しないためのガード
elLaunchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.isComposing) e.preventDefault();
});

// 打ち上げ / 参照系での追記 / 合流
elLauncher.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = elLaunchInput.value.trim();
  if (!text) return;

  let created: Grain;
  if (currentView === 'theme' && openThemeId) {
    // テーマの先端への追記
    const tip = themeTip(openThemeId);
    created = newGrain(text, { parents: tip ? [tip.id] : [], themeId: openThemeId });
  } else if (selection.length > 1) {
    // 合流: 複数の生きた粒を親とする新しい粒。無所属で生まれる
    created = newGrain(text, { parents: [...selection] });
    selection = [];
  } else if (selection.length === 1) {
    // 選択粒を親とする追記。親がテーマ所属ならテーマを継ぐ
    const parent = grainById(selection[0]);
    created = newGrain(text, { parents: [...selection], themeId: parent?.themeId ?? null });
    selection = [created.id]; // 思考の連鎖: 参照系は書いた粒に移る
  } else {
    created = newGrain(text); // 無所属で打ち上げ
  }
  elLaunchInput.value = '';
  commit();
});

// 付箋
function addSticker(targetId: string, text: string): void {
  const target = grainById(targetId);
  if (!target) return;
  newGrain(text, { parents: [targetId], attachedTo: targetId, themeId: target.themeId ?? null });
  commit();
}

// 閉幕: 印一つ。即時退場。一言は求めない（殺す操作は軽く）
function closeGrains(ids: string[]): void {
  for (const id of ids) {
    const g = grainById(id);
    if (g && g.status === 'alive') g.status = 'closed';
  }
  selection = selection.filter((id) => !ids.includes(id));
  commit();
}

// 析出: 粒に名を与えテーマにする
function precipitate(grainId: string): void {
  const g = grainById(grainId);
  if (!g || g.themeId) return;
  const name = window.prompt('テーマの名前:');
  if (!name || !name.trim()) return;
  const theme: Theme = { id: crypto.randomUUID(), name: name.trim(), createdAtWall: Date.now() };
  state.themes.push(theme);
  g.themeId = theme.id;
  commit();
}

// 蘇生: 一言が必須（生かす操作は重く）
function revive(grainId: string, note: string): boolean {
  const g = grainById(grainId);
  if (!g || g.status === 'alive') return false;
  if (!note.trim()) return false;
  g.status = 'alive';
  g.revivedNote = note.trim();
  touch(g, eco);
  commit();
  return true;
}

// 編集は訂正専用。時計は巻き戻さない
function correctText(grainId: string): void {
  const g = grainById(grainId);
  if (!g) return;
  const v = window.prompt('訂正（時計は動きません）:', g.text);
  if (v === null) return;
  const t = v.trim();
  if (t) g.text = t;
  saveState(state);
  render();
}

// ---------- テーマ ----------
function themeGrains(themeId: string): Grain[] {
  return state.grains.filter((g) => g.themeId === themeId);
}

function themeTip(themeId: string): Grain | undefined {
  // 先端 = 付箋でない最新の粒（生死を問わず系譜は続く）
  const main = themeGrains(themeId).filter((g) => !g.attachedToId);
  return main.sort((a, b) => b.createdAtWall - a.createdAtWall)[0];
}

// ---------- ビュー切り替え ----------
function showView(v: 'now' | 'theme' | 'search'): void {
  currentView = v;
  elField.hidden = v !== 'now';
  elField.style.display = v === 'now' ? '' : 'none';
  elThread.hidden = v !== 'theme';
  elSearch.hidden = v !== 'search';
  $('#nav-now').classList.toggle('active', v === 'now');
  $('#nav-search').classList.toggle('active', v === 'search');
  if (v !== 'theme') openThemeId = null;
  render();
  if (v === 'search') elSearchInput.focus();
  else elLaunchInput.focus();
}

$('#nav-now').addEventListener('click', () => showView('now'));
$('#nav-search').addEventListener('click', () => showView('search'));
$('#thread-back').addEventListener('click', () => showView('now'));

function openTheme(themeId: string): void {
  openThemeId = themeId;
  showView('theme');
}

// ---------- 描画 ----------
function render(): void {
  if (currentView === 'now') renderNow();
  else if (currentView === 'theme') renderThread();
  else renderSearch();
  renderToolbar();
  renderLauncherPlaceholder();
}

// 今の面: 角度=接触順、半径=冷え具合の放射配置。静止。枠なし
function renderNow(): void {
  elField.innerHTML = '<div id="center-dot"></div>';
  const w = elField.clientWidth;
  const h = elField.clientHeight;
  const cx = w / 2;
  const cy = h / 2;
  const short = Math.min(w, h);
  const rMin = short * P.RADIUS_MIN_RATIO;
  const rMax = short * P.RADIUS_MAX_RATIO;

  const grains = displayedGrains(state, eco).sort((a, b) => b.lastTouchEco - a.lastTouchEco);
  const n = grains.length;

  // まっさらな状態: サンプル読み込みの案内だけ静かに置く
  if (state.grains.length === 0) {
    const hint = document.createElement('div');
    hint.textContent = '例のデータで始める';
    hint.style.cssText =
      'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);color:#3a4152;font-size:13px;cursor:pointer;';
    hint.addEventListener('mouseenter', () => (hint.style.color = '#6b7280'));
    hint.addEventListener('mouseleave', () => (hint.style.color = '#3a4152'));
    hint.addEventListener('click', () => loadSample(false));
    elField.appendChild(hint);
    return;
  }

  grains.forEach((g, i) => {
    const effAge = effectiveAge(g, eco);
    const tier = tierOf(effAge);
    const frac = Math.min(1, effAge / P.SINK_AGE_SECONDS);
    const r = rMin + Math.pow(frac, 0.6) * (rMax - rMin);
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(n, 1);

    const div = document.createElement('div');
    div.className = 'grain';
    if (isOpenQuestion(g)) div.classList.add('question');
    if (selection.includes(g.id)) div.classList.add('selected');
    div.style.left = `${cx + r * Math.cos(angle)}px`;
    div.style.top = `${cy + r * Math.sin(angle)}px`;
    div.style.fontSize = `${tier.fontSizePx}px`;
    div.style.opacity = String(tier.opacity);
    div.title = g.text;

    if (g.themeId) {
      const theme = themeById(g.themeId);
      if (theme) {
        const name = document.createElement('span');
        name.className = 'theme-name';
        name.textContent = theme.name;
        name.addEventListener('click', (e) => {
          e.stopPropagation();
          openTheme(theme.id);
        });
        div.appendChild(name);
      }
    }

    const textSpan = document.createElement('span');
    textSpan.textContent = clip(g.text, P.NOW_TEXT_CLIP);
    div.appendChild(textSpan);

    // 選択は接触に数えない（閲覧・選択は代謝ゼロ）
    div.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey) {
        selection = selection.includes(g.id) ? selection.filter((id) => id !== g.id) : [...selection, g.id];
      } else {
        selection = selection.includes(g.id) && selection.length === 1 ? [] : [g.id];
      }
      renderNow();
      renderToolbar();
      renderLauncherPlaceholder();
    });
    div.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      correctText(g.id);
    });

    elField.appendChild(div);
  });
}

// テーマの尾: 系譜順の一本の読み物。先端が最初に見える
function renderThread(): void {
  if (!openThemeId) return;
  const theme = themeById(openThemeId);
  if (!theme) return;
  elThreadTitle.textContent = theme.name;
  elThreadList.innerHTML = '';

  // 本文の粒は新しい順(先端が最初)。付箋は貼り先の直下に置く
  const all = themeGrains(openThemeId);
  const mains = all.filter((g) => !g.attachedToId).sort((a, b) => b.createdAtWall - a.createdAtWall);
  const mainIds = new Set(mains.map((g) => g.id));
  const stickersOf = (id: string) =>
    all.filter((g) => g.attachedToId === id).sort((a, b) => a.createdAtWall - b.createdAtWall);
  // 貼り先が本文でない付箋(付箋への付箋など)は先頭にまとめる
  const orphans = all.filter((g) => g.attachedToId && !mainIds.has(g.attachedToId));
  const grains: Grain[] = [...orphans];
  for (const m of mains) {
    grains.push(m, ...stickersOf(m.id));
  }
  for (const g of grains) {
    const div = document.createElement('div');
    div.className = 'thread-grain';
    if (g.attachedToId) div.classList.add('sticker');
    if (isOpenQuestion(g)) div.classList.add('question');
    if (g.status !== 'alive') div.classList.add('dead');

    const text = document.createElement('div');
    text.className = 't-text';
    text.textContent = g.text;
    div.appendChild(text);

    const meta = document.createElement('div');
    meta.className = 't-meta';
    meta.textContent = `${fmtDate(g.createdAtWall)}${g.status === 'drifted' ? ' ・漂流' : g.status === 'closed' ? ' ・閉幕' : ''}`;
    div.appendChild(meta);

    div.addEventListener('dblclick', () => correctText(g.id));
    elThreadList.appendChild(div);
  }
}

// 検索: 生死を問わず全文検索。閲覧は代謝ゼロ。死んだ粒だけ蘇生できる
function renderSearch(): void {
  const q = elSearchInput.value.trim().toLowerCase();
  elSearchResults.innerHTML = '';
  if (!q) return;

  const hits = state.grains
    .filter(
      (g) =>
        g.text.toLowerCase().includes(q) ||
        (g.closedNote ?? '').toLowerCase().includes(q) ||
        (g.revivedNote ?? '').toLowerCase().includes(q),
    )
    .sort((a, b) => b.createdAtWall - a.createdAtWall)
    .slice(0, 100);

  for (const g of hits) {
    const div = document.createElement('div');
    div.className = 'result';
    if (g.status !== 'alive') div.classList.add('dead');

    const text = document.createElement('div');
    text.className = 'r-text';
    text.textContent = g.text;
    div.appendChild(text);

    const meta = document.createElement('div');
    meta.className = 'r-meta';
    const statusLabel = g.status === 'alive' ? '生' : g.status === 'drifted' ? '漂流' : '閉幕';
    meta.innerHTML = `<span class="r-status">${statusLabel}</span><span>${fmtDate(g.createdAtWall)}</span>`;
    if (g.themeId) {
      const theme = themeById(g.themeId);
      if (theme) {
        const link = document.createElement('span');
        link.className = 'r-theme-link';
        link.textContent = theme.name;
        link.addEventListener('click', () => openTheme(theme.id));
        meta.appendChild(link);
      }
    }
    if (g.closedNote) {
      const note = document.createElement('span');
      note.className = 'r-note';
      note.textContent = `「${g.closedNote}」`;
      meta.appendChild(note);
    }
    if (g.revivedNote) {
      const note = document.createElement('span');
      note.className = 'r-note';
      note.textContent = `蘇生: ${g.revivedNote}`;
      meta.appendChild(note);
    }
    div.appendChild(meta);

    if (g.status !== 'alive') {
      // 蘇生: 一言が必須
      const box = document.createElement('div');
      box.className = 'revive-box';
      const input = document.createElement('input');
      input.placeholder = 'なぜ戻すか（必須）';
      const btn = document.createElement('button');
      btn.textContent = '蘇生';
      btn.addEventListener('click', () => {
        if (revive(g.id, input.value)) renderSearch();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) {
          e.preventDefault();
          if (revive(g.id, input.value)) renderSearch();
        }
      });
      box.appendChild(input);
      box.appendChild(btn);
      div.appendChild(box);

      if (g.status === 'closed' && !g.closedNote) {
        const noteBtn = document.createElement('button');
        noteBtn.textContent = '閉幕の一言';
        noteBtn.style.cssText = 'background:none;border:none;color:#3a4152;font-size:10px;cursor:pointer;padding:0;margin-top:2px;';
        noteBtn.addEventListener('click', () => {
          const v = window.prompt('どう閉じたか（任意）:');
          if (v && v.trim()) {
            g.closedNote = v.trim();
            saveState(state);
            renderSearch();
          }
        });
        div.appendChild(noteBtn);
      }
    }

    elSearchResults.appendChild(div);
  }
}

elSearchInput.addEventListener('input', () => renderSearch());

// 選択時ツールバー
function renderToolbar(): void {
  if (currentView !== 'now' || selection.length === 0) {
    elToolbar.hidden = true;
    elToolbar.innerHTML = '';
    return;
  }
  elToolbar.hidden = false;
  elToolbar.innerHTML = '';

  if (selection.length === 1) {
    const g = grainById(selection[0]);
    if (!g) { selection = []; elToolbar.hidden = true; return; }

    const stickerInput = document.createElement('input');
    stickerInput.placeholder = '付箋を貼る（Enter）';
    stickerInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        const t = stickerInput.value.trim();
        if (t) addSticker(g.id, t);
      }
    });
    elToolbar.appendChild(stickerInput);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'close-btn';
    closeBtn.textContent = '閉幕 ×';
    closeBtn.addEventListener('click', () => closeGrains([g.id]));
    elToolbar.appendChild(closeBtn);

    if (!g.themeId) {
      const precBtn = document.createElement('button');
      precBtn.textContent = '析出';
      precBtn.addEventListener('click', () => precipitate(g.id));
      elToolbar.appendChild(precBtn);
    } else {
      const theme = themeById(g.themeId);
      if (theme) {
        const openBtn = document.createElement('button');
        openBtn.textContent = `尾を開く: ${theme.name}`;
        openBtn.addEventListener('click', () => openTheme(theme.id));
        elToolbar.appendChild(openBtn);
      }
    }
  } else {
    const info = document.createElement('span');
    info.textContent = `${selection.length}粒を選択中 — 下の入力欄で合流の一粒を書く`;
    elToolbar.appendChild(info);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'close-btn';
    closeBtn.textContent = 'まとめて閉幕 ×';
    closeBtn.addEventListener('click', () => closeGrains([...selection]));
    elToolbar.appendChild(closeBtn);
  }

  const clearBtn = document.createElement('button');
  clearBtn.textContent = '選択解除';
  clearBtn.addEventListener('click', () => {
    selection = [];
    render();
  });
  elToolbar.appendChild(clearBtn);
}

function renderLauncherPlaceholder(): void {
  if (currentView === 'theme' && openThemeId) {
    const theme = themeById(openThemeId);
    elLaunchInput.placeholder = theme ? `「${theme.name}」の先端に追記（Enter）` : '追記（Enter）';
  } else if (selection.length > 1) {
    elLaunchInput.placeholder = `${selection.length}粒を合流する一粒を書く（Enter）`;
  } else if (selection.length === 1) {
    const g = grainById(selection[0]);
    elLaunchInput.placeholder = g ? `「${clip(g.text, 12)}」に続ける（Enter）` : '打ち上げ（Enter）';
  } else {
    elLaunchInput.placeholder = '打ち上げ（Enter）';
  }
}

// Escで選択解除
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && selection.length > 0) {
    selection = [];
    render();
  }
});

// 背景クリックで選択解除
elField.addEventListener('click', (e) => {
  if (e.target === elField && selection.length > 0) {
    selection = [];
    render();
  }
});

window.addEventListener('resize', () => {
  if (currentView === 'now') renderNow();
});

// ---------- サンプルデータ ----------
function loadSample(needConfirm: boolean): void {
  if (needConfirm && state.grains.length > 0) {
    if (!window.confirm('現在のデータをサンプルで置き換えます。よろしいですか?（先に「書き出し」で退避できます）')) return;
  }
  state = buildSampleState();
  eco = state.ecoSeconds;
  selection = [];
  cull(state, eco);
  saveState(state);
  showView('now');
}

$('#btn-sample').addEventListener('click', () => loadSample(true));

// ---------- エクスポート / インポート ----------
$('#btn-export').addEventListener('click', () => {
  state.ecoSeconds = eco;
  exportJson(state);
});

$<HTMLInputElement>('#btn-import').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const text = await file.text();
  const imported = parseImportedJson(text);
  if (!imported) {
    window.alert('読み込めないファイルです');
    return;
  }
  if (!window.confirm('現在のデータを読み込んだ内容で置き換えます。よろしいですか?')) return;
  state = imported;
  eco = state.ecoSeconds;
  selection = [];
  cull(state, eco);
  saveState(state);
  render();
  (e.target as HTMLInputElement).value = '';
});

// ---------- ユーティリティ ----------
function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---------- 起動 ----------
cull(state, eco); // 前回終了後の状態でも規律を守らせてから描画
saveState(state);
showView('now');
