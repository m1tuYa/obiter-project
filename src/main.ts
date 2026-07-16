import './style.css';
import { PARAMS as P } from './params';
import type { Grain, State, Theme } from './types';
import { loadState, saveState, exportJson, parseImportedJson } from './store';
import { cull, isOpenQuestion, touch } from './ecosystem';
import { buildSampleState } from './sample';
import { Sky } from './sky';

// ============================================================
// UIの原則: 常設の道具を持たない。すべては召喚される。
// - 書く: 打ち始めるだけ(入力行が浮かび上がる)
// - 操作: 選択時のみ静かなグリフが浮かぶ
// - 検索: / で空の上に降りてくる
// - テーマの尾: 右から帯が滑り込む(空は回り続ける)
// - Esc: 入力 → 検索/帯 → 選択 の順に一段ずつ引く
// ============================================================

// ---------- 状態 ----------
let state: State = loadState();
let eco = state.ecoSeconds;
let selection: string[] = [];
let sky: Sky;

type WriterMode = 'launch' | 'child' | 'sticker' | 'merge' | 'append' | 'theme-name' | 'correct';
let writerMode: WriterMode | null = null;
let correctTargetId: string | null = null;
let bandThemeId: string | null = null;
let searchOpen = false;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const elEmptyHint = $('#empty-hint');
const elActions = $('#actions');
const elWriter = $<HTMLFormElement>('#writer');
const elWriterContext = $('#writer-context');
const elWriterInput = $<HTMLInputElement>('#writer-input');
const elSearchOverlay = $('#search-overlay');
const elSearchInput = $<HTMLInputElement>('#search-input');
const elSearchResults = $('#search-results');
const elBand = $('#band');
const elBandTitle = $('#band-title');
const elBandList = $('#band-list');
const elCornerToggle = $('#corner-toggle');
const elCornerMenu = $('#corner-menu');

const grainById = (id: string) => state.grains.find((g) => g.id === id);
const themeById = (id: string) => state.themes.find((t) => t.id === id);

// ---------- 生態系時刻(滞在時間でのみ進む。不在中は凍結) ----------
let tickCount = 0;
setInterval(() => {
  if (document.hidden || !document.hasFocus()) return;
  tickCount++;
  eco += P.DEBUG_TIME_SCALE;
  state.ecoSeconds = eco;
  if (tickCount % 5 === 0 && cull(state, eco)) render();
  if (tickCount % 15 === 0) saveState(state);
}, 1000);

window.addEventListener('beforeunload', () => {
  state.ecoSeconds = eco;
  saveState(state);
});

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
  sky.onSelectionChanged(selection);
  render();
}

function setSelection(ids: string[]): void {
  selection = ids;
  sky.onSelectionChanged(ids);
  if (writerMode && writerMode !== 'theme-name' && writerMode !== 'correct') {
    writerMode = inferWriteMode();
    updateWriterContext();
  }
  render();
}

function newGrain(
  text: string,
  opts: { parents?: string[]; attachedTo?: string | null; themeId?: string | null } = {},
): Grain {
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
  // 接触: 親(付箋の貼り先・追記元・合流元)の時計が巻き戻る
  for (const pid of g.parentIds) {
    const p = grainById(pid);
    if (p) touch(p, eco);
  }
  state.grains.push(g);
  return g;
}

// ---------- 操作 ----------

function addSticker(targetId: string, text: string): void {
  const target = grainById(targetId);
  if (!target) return;
  newGrain(text, { parents: [targetId], attachedTo: targetId, themeId: target.themeId ?? null });
  commit();
}

// 閉幕: 印一つ。即時退場。一言は求めない(殺す操作は軽く)
function closeGrains(ids: string[]): void {
  for (const id of ids) {
    const g = grainById(id);
    if (g && g.status === 'alive') g.status = 'closed';
  }
  selection = selection.filter((id) => !ids.includes(id));
  sky.onSelectionChanged(selection);
  commit();
}

// 析出: 粒に名を与えテーマにする
function precipitate(grainId: string, name: string): void {
  const g = grainById(grainId);
  if (!g || g.themeId || !name.trim()) return;
  const theme: Theme = { id: crypto.randomUUID(), name: name.trim(), createdAtWall: Date.now() };
  state.themes.push(theme);
  g.themeId = theme.id;
  commit();
}

// 蘇生: 一言が必須(生かす操作は重く)
function revive(grainId: string, note: string): boolean {
  const g = grainById(grainId);
  if (!g || g.status === 'alive' || !note.trim()) return false;
  g.status = 'alive';
  g.revivedNote = note.trim();
  touch(g, eco);
  commit();
  return true;
}

// ---------- テーマ ----------
function themeGrains(themeId: string): Grain[] {
  return state.grains.filter((g) => g.themeId === themeId);
}

function themeTip(themeId: string): Grain | undefined {
  const main = themeGrains(themeId).filter((g) => !g.attachedToId);
  return main.sort((a, b) => b.createdAtWall - a.createdAtWall)[0];
}

// ============================================================
// 書く行(writer)
// ============================================================

function inferWriteMode(): WriterMode {
  if (selection.length > 1) return 'merge';
  if (selection.length === 1) return 'child';
  if (bandThemeId) return 'append';
  return 'launch';
}

function openWriter(mode: WriterMode): void {
  writerMode = mode;
  elWriter.hidden = false;
  updateWriterContext();
  elWriterInput.focus();
}

function closeWriter(): void {
  writerMode = null;
  correctTargetId = null;
  elWriterInput.value = '';
  elWriter.hidden = true;
}

function updateWriterContext(): void {
  if (!writerMode) return;
  let text = '';
  switch (writerMode) {
    case 'launch':
      text = '打ち上げ';
      break;
    case 'child': {
      const g = grainById(selection[0]);
      text = g ? `「${clip(g.text, 14)}」に続ける — tabで付箋に` : '打ち上げ';
      break;
    }
    case 'sticker': {
      const g = grainById(selection[0]);
      text = g ? `「${clip(g.text, 14)}」に付箋 — tabで続けるに` : '付箋';
      break;
    }
    case 'merge':
      text = `${selection.length}粒を合流する一粒を書く`;
      break;
    case 'append': {
      const t = bandThemeId ? themeById(bandThemeId) : undefined;
      text = t ? `「${t.name}」の先端に追記` : '追記';
      break;
    }
    case 'theme-name':
      text = '析出 — この粒の主題に名を与える';
      break;
    case 'correct':
      text = '訂正 — 時計は動かない';
      break;
  }
  elWriterContext.textContent = text;
}

elWriterInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.isComposing) {
    e.preventDefault();
    return;
  }
  if (e.key === 'Escape') {
    e.stopPropagation();
    closeWriter();
    return;
  }
  // tabで 続ける⇄付箋 を切り替える(単一選択のときだけ)
  if (e.key === 'Tab' && selection.length === 1 && (writerMode === 'child' || writerMode === 'sticker')) {
    e.preventDefault();
    writerMode = writerMode === 'child' ? 'sticker' : 'child';
    updateWriterContext();
  }
});

elWriter.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = elWriterInput.value.trim();
  if (!text || !writerMode) return;

  switch (writerMode) {
    case 'launch': {
      newGrain(text);
      elWriterInput.value = '';
      commit();
      break;
    }
    case 'child': {
      const parent = grainById(selection[0]);
      const created = newGrain(text, {
        parents: parent ? [parent.id] : [],
        themeId: parent?.themeId ?? null,
      });
      selection = [created.id]; // 思考の連鎖: 参照系は書いた粒に移る
      sky.onSelectionChanged(selection);
      elWriterInput.value = '';
      writerMode = 'child';
      commit();
      updateWriterContext();
      break;
    }
    case 'sticker': {
      if (selection.length === 1) addSticker(selection[0], text);
      closeWriter();
      break;
    }
    case 'merge': {
      const created = newGrain(text, { parents: [...selection] });
      selection = [created.id];
      sky.onSelectionChanged(selection);
      elWriterInput.value = '';
      writerMode = 'child';
      commit();
      updateWriterContext();
      break;
    }
    case 'append': {
      if (bandThemeId) {
        const tip = themeTip(bandThemeId);
        newGrain(text, { parents: tip ? [tip.id] : [], themeId: bandThemeId });
        elWriterInput.value = '';
        commit();
      }
      break;
    }
    case 'theme-name': {
      if (selection.length === 1) precipitate(selection[0], text);
      closeWriter();
      break;
    }
    case 'correct': {
      if (correctTargetId) {
        const g = grainById(correctTargetId);
        if (g) g.text = text; // 編集は訂正専用。時計は巻き戻さない
        saveState(state);
        render();
      }
      closeWriter();
      break;
    }
  }
});

function beginCorrect(grainId: string): void {
  const g = grainById(grainId);
  if (!g) return;
  correctTargetId = grainId;
  openWriter('correct');
  elWriterInput.value = g.text;
  elWriterInput.select();
}

// ============================================================
// 操作グリフ(選択時のみ)
// ============================================================

function renderGlyphs(): void {
  if (selection.length === 0) {
    elActions.hidden = true;
    elActions.innerHTML = '';
    return;
  }
  elActions.hidden = false;
  elActions.innerHTML = '';

  const glyph = (label: string, cls: string, fn: () => void) => {
    const el = document.createElement('span');
    el.className = `glyph ${cls}`;
    el.textContent = label;
    el.addEventListener('click', fn);
    elActions.appendChild(el);
  };
  const sep = () => {
    const el = document.createElement('span');
    el.className = 'sep';
    el.textContent = '·';
    elActions.appendChild(el);
  };

  if (selection.length === 1) {
    const g = grainById(selection[0]);
    if (!g) {
      elActions.hidden = true;
      return;
    }
    glyph('付箋', '', () => openWriter('sticker'));
    sep();
    glyph('閉幕', 'close', () => closeGrains([g.id]));
    sep();
    if (!g.themeId) {
      glyph('析出', '', () => openWriter('theme-name'));
    } else {
      const t = themeById(g.themeId);
      glyph(t ? `尾 — ${t.name}` : '尾', '', () => g.themeId && openBand(g.themeId));
    }
    sep();
    glyph('訂正', '', () => beginCorrect(g.id));
  } else {
    const note = document.createElement('span');
    note.className = 'note';
    note.textContent = `${selection.length}粒 — 打ち始めれば合流`;
    elActions.appendChild(note);
    sep();
    glyph('まとめて閉幕', 'close', () => closeGrains([...selection]));
  }
}

// ============================================================
// テーマの尾(帯)
// ============================================================

function openBand(themeId: string): void {
  bandThemeId = themeId;
  elBand.hidden = false;
  closeSearch();
  renderBand();
  if (writerMode && writerMode !== 'theme-name' && writerMode !== 'correct') {
    writerMode = inferWriteMode();
    updateWriterContext();
  }
}

function closeBand(): void {
  bandThemeId = null;
  elBand.hidden = true;
  if (writerMode === 'append') {
    writerMode = inferWriteMode();
    updateWriterContext();
  }
}

function renderBand(): void {
  if (!bandThemeId) return;
  const theme = themeById(bandThemeId);
  if (!theme) {
    closeBand();
    return;
  }
  elBandTitle.textContent = theme.name;
  elBandList.innerHTML = '';

  // 本文は新しい順(先端が最初)。付箋は貼り先の直下に
  const all = themeGrains(bandThemeId);
  const mains = all.filter((g) => !g.attachedToId).sort((a, b) => b.createdAtWall - a.createdAtWall);
  const mainIds = new Set(mains.map((g) => g.id));
  const stickersOf = (id: string) =>
    all.filter((g) => g.attachedToId === id).sort((a, b) => a.createdAtWall - b.createdAtWall);
  const orphans = all.filter((g) => g.attachedToId && !mainIds.has(g.attachedToId));
  const ordered: Grain[] = [...orphans];
  for (const m of mains) ordered.push(m, ...stickersOf(m.id));

  for (const g of ordered) {
    const div = document.createElement('div');
    div.className = 'band-grain';
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

    div.addEventListener('dblclick', () => beginCorrect(g.id));
    elBandList.appendChild(div);
  }
}

$('#band-close').addEventListener('click', () => closeBand());

// ============================================================
// 検索(/で召喚)
// ============================================================

function openSearch(): void {
  searchOpen = true;
  elSearchOverlay.hidden = false;
  closeWriter();
  elSearchInput.focus();
  renderSearch();
}

function closeSearch(): void {
  if (!searchOpen) return;
  searchOpen = false;
  elSearchOverlay.hidden = true;
  elSearchInput.value = '';
  elSearchResults.innerHTML = '';
}

elSearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    closeSearch();
  }
});

elSearchOverlay.addEventListener('click', (e) => {
  if (e.target === elSearchOverlay) closeSearch();
});

elSearchInput.addEventListener('input', () => renderSearch());

function renderSearch(): void {
  if (!searchOpen) return;
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
    const status = document.createElement('span');
    status.textContent = g.status === 'alive' ? '生' : g.status === 'drifted' ? '漂流' : '閉幕';
    meta.appendChild(status);
    const date = document.createElement('span');
    date.textContent = fmtDate(g.createdAtWall);
    meta.appendChild(date);
    if (g.themeId) {
      const theme = themeById(g.themeId);
      if (theme) {
        const link = document.createElement('span');
        link.className = 'r-theme-link';
        link.textContent = theme.name;
        link.addEventListener('click', () => openBand(theme.id));
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
      const box = document.createElement('div');
      box.className = 'revive-box';
      const input = document.createElement('input');
      input.placeholder = 'なぜ戻すか(必須)';
      const go = document.createElement('span');
      go.className = 'revive-go';
      go.textContent = '蘇生';
      go.addEventListener('click', () => {
        if (revive(g.id, input.value)) renderSearch();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) {
          e.preventDefault();
          if (revive(g.id, input.value)) renderSearch();
        }
        if (e.key === 'Escape') e.stopPropagation();
      });
      box.appendChild(input);
      box.appendChild(go);
      div.appendChild(box);

      if (g.status === 'closed' && !g.closedNote) {
        const add = document.createElement('div');
        add.className = 'closed-note-add';
        add.textContent = '+ 閉幕の一言';
        add.addEventListener('click', () => {
          const v = window.prompt('どう閉じたか(任意):');
          if (v && v.trim()) {
            g.closedNote = v.trim();
            saveState(state);
            renderSearch();
          }
        });
        div.appendChild(add);
      }
    }

    elSearchResults.appendChild(div);
  }
}

// ============================================================
// キーボード(型即書き・Escの段階後退・Delete閉幕)
// ============================================================

document.addEventListener('keydown', (e) => {
  const a = document.activeElement;
  const typing = a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement;

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openSearch();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || typing) return;

  if (e.key === 'Escape') {
    // 段階後退: 検索/帯 → 選択
    if (searchOpen) {
      closeSearch();
    } else if (bandThemeId) {
      closeBand();
    } else if (selection.length > 0) {
      setSelection([]);
    }
    return;
  }
  if (e.key === 'Delete') {
    if (selection.length > 0) closeGrains([...selection]);
    return;
  }
  if (e.key === '/') {
    e.preventDefault();
    openSearch();
    return;
  }
  // 打ち始める=書く。IMEの最初のキー(Process)も拾う
  if ((e.key.length === 1 && e.key !== ' ') || e.key === 'Process') {
    if (!writerMode) openWriter(inferWriteMode());
    elWriterInput.focus();
  }
});

// ============================================================
// 右上の格納庫
// ============================================================

elCornerToggle.addEventListener('click', () => {
  elCornerMenu.hidden = !elCornerMenu.hidden;
});

document.addEventListener('click', (e) => {
  if (!elCornerMenu.hidden && !(e.target as HTMLElement).closest('#corner')) {
    elCornerMenu.hidden = true;
  }
});

$('#menu-sample').addEventListener('click', () => {
  elCornerMenu.hidden = true;
  loadSample(true);
});

$('#menu-export').addEventListener('click', () => {
  elCornerMenu.hidden = true;
  state.ecoSeconds = eco;
  exportJson(state);
});

$<HTMLInputElement>('#menu-import').addEventListener('change', async (e) => {
  elCornerMenu.hidden = true;
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
  closeBand();
  closeSearch();
  sky.onSelectionChanged([]);
  cull(state, eco);
  saveState(state);
  render();
  (e.target as HTMLInputElement).value = '';
});

// ---------- サンプルデータ ----------
function loadSample(needConfirm: boolean): void {
  if (needConfirm && state.grains.length > 0) {
    if (!window.confirm('現在のデータをサンプルで置き換えます。よろしいですか?(先に「書き出し」で退避できます)')) return;
  }
  state = buildSampleState();
  eco = state.ecoSeconds;
  selection = [];
  closeBand();
  closeSearch();
  sky.onSelectionChanged([]);
  cull(state, eco);
  saveState(state);
  render();
}

$('#sample-link').addEventListener('click', () => loadSample(false));

// ============================================================
// 描画
// ============================================================

function render(): void {
  elEmptyHint.hidden = state.grains.length !== 0;
  renderGlyphs();
  if (bandThemeId) renderBand();
  if (searchOpen) renderSearch();
}

// ---------- ユーティリティ ----------
function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---------- 起動 ----------
sky = new Sky($<HTMLCanvasElement>('#sky-canvas'), {
  getState: () => state,
  getEco: () => eco,
  getSelection: () => selection,
  setSelection,
  openTheme: (id: string) => openBand(id),
  correct: beginCorrect,
  closeGrain: (id: string) => closeGrains([id]),
  isActive: () => true,
});
cull(state, eco); // 前回終了後の状態でも規律を守らせてから描画
saveState(state);
render();
