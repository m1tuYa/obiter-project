import './style.css';
import { PARAMS as P } from './params';
import type { Grain, State, Theme } from './types';
import { loadState, saveState, exportJson, parseImportedJson } from './store';
import { cull, ensureAngles, hashAngle, isAwayComet, isOpenQuestion, similarity, touch } from './ecosystem';
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
ensureAngles(state);
let eco = state.ecoSeconds;
let selection: string[] = [];
let sky: Sky;

type WriterMode = 'launch' | 'child' | 'sticker' | 'merge' | 'append' | 'theme-name' | 'correct' | 'comet';
let writerMode: WriterMode | null = null;
let correctTargetId: string | null = null;
let cometTargetId: string | null = null;
let bandThemeId: string | null = null;
let searchOpen = false;
let echoTargetId: string | null = null;
let lastClosedIds: string[] | null = null; // 直後のCtrl+Zで戻せる(誤爆の訂正)

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const elEmptyHint = $('#empty-hint');
const elActions = $('#actions');
const elWriter = $<HTMLFormElement>('#writer');
const elWriterContext = $('#writer-context');
const elWriterInput = $<HTMLTextAreaElement>('#writer-input');
const elEchoOverlay = $('#echo-overlay');
const elEchoTitle = $('#echo-title');
const elEchoResults = $('#echo-results');
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
  if (checkCometReturns()) render();
  if (tickCount % 5 === 0 && cull(state, eco, Date.now())) render();
  if (tickCount % 15 === 0) persistState();
}, 1000);

window.addEventListener('beforeunload', () => {
  state.ecoSeconds = eco;
  persistState();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    state.ecoSeconds = eco;
    persistState();
  }
});

// ---------- 変異の共通処理 ----------
function commit(): void {
  cull(state, eco, Date.now());
  persistState();
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
  const id = crypto.randomUUID();
  // 固有の角度: 親(貼り先・追記元)がいればそのそば、無所属なら空のどこかへ。以後他の星の出来事では動かない
  const anchorId = opts.attachedTo ?? opts.parents?.[0];
  const anchor = anchorId ? grainById(anchorId) : undefined;
  const angle =
    anchor && typeof anchor.angle === 'number'
      ? anchor.angle + (Math.random() - 0.5) * 0.5
      : hashAngle(id) + Math.random() * 0.3;
  const g: Grain = {
    id,
    text,
    createdAtWall: Date.now(),
    lastTouchEco: eco,
    status: 'alive',
    parentIds: opts.parents ?? [],
    attachedToId: opts.attachedTo ?? null,
    themeId: opts.themeId ?? null,
    cometReturnAtWall: null,
    angle,
  };
  // 接触: 親(付箋の貼り先・追記元・合流元)の時計が巻き戻る
  for (const pid of g.parentIds) {
    const p = grainById(pid);
    if (p) touch(p, eco);
  }
  state.grains.push(g);
  if (sky) sky.noteLaunch(g.id); // 打ち上げ: 地面から発つ
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
  const done: string[] = [];
  for (const id of ids) {
    const g = grainById(id);
    if (g && g.status === 'alive') {
      sky.noteEntry(id); // 突入: 一瞬燃えて、惑星に積もる
      g.status = 'closed';
      g.closedAtWall = Date.now();
      done.push(id);
    }
  }
  if (done.length > 0) lastClosedIds = done;
  selection = selection.filter((id) => !ids.includes(id));
  sky.onSelectionChanged(selection);
  commit();
}

// 直前の閉幕を戻す(蘇生ではなく、手が滑ったことへの訂正)
function undoClose(): void {
  if (!lastClosedIds) return;
  for (const id of lastClosedIds) {
    const g = grainById(id);
    if (g && g.status === 'closed') {
      g.status = 'alive';
      g.closedAtWall = undefined;
    }
  }
  lastClosedIds = null;
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

// ---------- 彗星 ----------

// 帰還時刻が来た彗星を空へ戻す(壁時計で判定する唯一の存在)
function checkCometReturns(): boolean {
  const now = Date.now();
  let changed = false;
  for (const g of state.grains) {
    if (g.status === 'alive' && g.cometReturnAtWall != null && now >= g.cometReturnAtWall) {
      returnComet(g);
      changed = true;
    }
  }
  if (changed) persistState();
  return changed;
}

function returnComet(g: Grain): void {
  g.cometLastReturnAtWall = g.cometReturnAtWall ?? Date.now();
  g.cometReturnAtWall = null;
  g.cometTail = true;
  g.lastTouchEco = eco; // 近日点=熱い。以後は死の一法則に合流する
  sky.noteReturn(g.id);
}

// 彗星として打ち出す: 帰還日(と任意の周期)を与え、空から去らせる
function sendComet(grainId: string, returnAt: number, periodDays: number | null): void {
  const g = grainById(grainId);
  if (!g || g.status !== 'alive') return;
  sky.noteDeparture(grainId);
  g.cometReturnAtWall = returnAt;
  g.cometPeriodDays = periodDays;
  g.cometLastReturnAtWall = null;
  g.cometTail = false;
  selection = selection.filter((id) => id !== grainId);
  sky.onSelectionChanged(selection);
  commit();
}

// 呼び戻す: 帰還日を待たずに今戻す
function recallComet(grainId: string): void {
  const g = grainById(grainId);
  if (!g || g.cometReturnAtWall == null) return;
  returnComet(g);
  commit();
}

// 軌道を消す: 彗星であることをやめる(視界外なら今すぐ戻す)
function clearOrbit(grainId: string): void {
  const g = grainById(grainId);
  if (!g) return;
  const wasAway = g.cometReturnAtWall != null;
  g.cometReturnAtWall = null;
  g.cometPeriodDays = null;
  g.cometLastReturnAtWall = null;
  g.cometTail = false;
  if (wasAway) {
    g.lastTouchEco = eco;
    sky.noteReturn(grainId);
  }
  commit();
}

// 日付の軽い記法を解釈する。例: 7/20 / 7/20 14:00 / +3日 / 明日 / 金曜 / 毎週金曜 / 毎3日
function parseCometInput(raw: string): { at: number; period: number | null } | null {
  let s = raw.trim().replace(/\s+/g, ' ');
  if (!s) return null;
  let period: number | null = null;

  const mai = s.match(/^毎(日|週|月|(\d+)日)\s*(.*)$/);
  if (mai) {
    period = mai[1] === '日' ? 1 : mai[1] === '週' ? 7 : mai[1] === '月' ? 30 : parseInt(mai[2], 10);
    s = (mai[3] ?? '').trim();
  }

  const now = new Date();
  const at9 = (d: Date): Date => {
    d.setHours(9, 0, 0, 0);
    return d;
  };
  let at: number | null = null;

  if (!s) {
    if (period == null) return null;
    at = at9(new Date(now.getTime() + period * 86400000)).getTime();
  } else {
    let m: RegExpMatchArray | null;
    if ((m = s.match(/^\+(\d+)(d|日)$/))) {
      at = now.getTime() + parseInt(m[1], 10) * 86400000;
    } else if (s === '明日') {
      at = at9(new Date(now.getTime() + 86400000)).getTime();
    } else if (s === '明後日') {
      at = at9(new Date(now.getTime() + 2 * 86400000)).getTime();
    } else if ((m = s.match(/^(日|月|火|水|木|金|土)(曜日?)?$/))) {
      const target = '日月火水木金土'.indexOf(m[1]);
      let ahead = (target - now.getDay() + 7) % 7;
      if (ahead === 0) ahead = 7;
      at = at9(new Date(now.getTime() + ahead * 86400000)).getTime();
    } else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/))) {
      const d = new Date(now.getFullYear(), parseInt(m[1], 10) - 1, parseInt(m[2], 10));
      if (m[3]) d.setHours(parseInt(m[3], 10), parseInt(m[4], 10), 0, 0);
      else at9(d);
      if (d.getTime() <= now.getTime()) d.setFullYear(d.getFullYear() + 1);
      at = d.getTime();
    }
  }

  if (at == null || at <= Date.now()) return null;
  return { at, period };
}

// 細い幹を張る: 星を星に落とすと子としてリンクし、そのそばへ移る。
// 幹(parentIds)は不変なので、後から張る参照は linkIds に持つ。時計は巻き戻さない
function linkGrains(childId: string, targetId: string): void {
  if (childId === targetId) return;
  const child = grainById(childId);
  const target = grainById(targetId);
  if (!child || !target) return;
  child.linkIds = child.linkIds ?? [];
  if (!child.linkIds.includes(targetId) && !child.parentIds.includes(targetId) && child.attachedToId !== targetId) {
    child.linkIds.push(targetId);
  }
  if (typeof target.angle === 'number') {
    child.angle = target.angle + (Math.random() - 0.5) * 0.5;
  }
  persistState();
  render();
}

// 角度の調整(ドラッグで空に落とす)。半径=温度は変えられない
function repositionGrain(grainId: string, angle: number): void {
  const g = grainById(grainId);
  if (!g) return;
  g.angle = angle;
  persistState();
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
  if (selection.length === 1) {
    const g = grainById(selection[0]);
    if (g && isAwayComet(g)) return 'launch'; // 軌道上の彗星には書き足さない
    return 'child';
  }
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
  cometTargetId = null;
  elWriterInput.value = '';
  elWriterInput.style.height = 'auto';
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
    case 'comet':
      text = '彗星 — いつ戻すか(例: 7/20、+3日、金曜、毎週金曜、毎3日)';
      break;
  }
  elWriterContext.textContent = text;
}

elWriterInput.addEventListener('keydown', (e) => {
  // Enter=打ち上げ、Shift+Enter=改行(一呼吸の長さは行数ではなく本人が決める)
  if (e.key === 'Enter') {
    if (e.isComposing) return;
    if (!e.shiftKey) {
      e.preventDefault();
      elWriter.requestSubmit();
    }
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

// 入力量に合わせて静かに伸びる
elWriterInput.addEventListener('input', () => {
  elWriterInput.style.height = 'auto';
  elWriterInput.style.height = `${elWriterInput.scrollHeight}px`;
});

elWriter.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = elWriterInput.value.trim();
  if (!text || !writerMode) return;

  switch (writerMode) {
    case 'launch': {
      newGrain(text);
      elWriterInput.value = '';
      elWriterInput.style.height = 'auto';
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
      elWriterInput.style.height = 'auto';
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
      elWriterInput.style.height = 'auto';
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
        elWriterInput.style.height = 'auto';
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
        persistState();
        render();
      }
      closeWriter();
      break;
    }
    case 'comet': {
      const parsed = parseCometInput(text);
      if (!parsed) {
        elWriterContext.textContent = '読めない日付です。例: 7/20、7/20 14:00、+3日、金曜、毎週金曜';
        return;
      }
      if (cometTargetId) sendComet(cometTargetId, parsed.at, parsed.period);
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
    if (isAwayComet(g)) {
      // 軌道上の彗星: 遠くにいる粒への操作は最小限
      glyph('呼び戻す', '', () => recallComet(g.id));
      sep();
      glyph('軌道を消す', '', () => clearOrbit(g.id));
      sep();
      glyph('閉幕', 'close', () => closeGrains([g.id]));
      elActions.appendChild(document.createElement('span'));
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
    glyph('彗星', '', () => {
      cometTargetId = g.id;
      openWriter('comet');
    });
    sep();
    glyph('残響', '', () => openEcho(g.id));
    sep();
    glyph('訂正', '', () => beginCorrect(g.id));
    if (g.cometPeriodDays) {
      sep();
      glyph('軌道を消す', '', () => clearOrbit(g.id));
    }
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
// 残響: 選択粒に似た過去の粒。求めたときだけ計算される(保存しない)
// ============================================================

function openEcho(grainId: string): void {
  const g = grainById(grainId);
  if (!g) return;
  echoTargetId = grainId;
  elEchoOverlay.hidden = false;
  closeWriter();
  renderEcho();
}

function closeEcho(): void {
  echoTargetId = null;
  elEchoOverlay.hidden = true;
  elEchoResults.innerHTML = '';
}

elEchoOverlay.addEventListener('click', (e) => {
  if (e.target === elEchoOverlay) closeEcho();
});

function renderEcho(): void {
  if (!echoTargetId) return;
  const g = grainById(echoTargetId);
  if (!g) {
    closeEcho();
    return;
  }
  elEchoTitle.textContent = `残響 — 「${clip(g.text, 24)}」に似た粒`;
  elEchoResults.innerHTML = '';

  const hits = state.grains
    .filter((x) => x.id !== g.id)
    .map((x) => ({ g: x, score: similarity(g.text, x.text) }))
    .filter((x) => x.score >= P.ECHO_MIN_SIMILARITY)
    .sort((a, b) => b.score - a.score)
    .slice(0, P.ECHO_MAX_RESULTS);

  if (hits.length === 0) {
    const empty = document.createElement('div');
    empty.id = 'echo-empty';
    empty.textContent = '静かです。この粒に似た響きはまだ眠っていません';
    elEchoResults.appendChild(empty);
    return;
  }

  for (const { g: hit } of hits) {
    const div = document.createElement('div');
    div.className = 'result';
    if (hit.status !== 'alive') div.classList.add('dead');

    const text = document.createElement('div');
    text.className = 'r-text';
    text.textContent = hit.text;
    div.appendChild(text);

    const meta = document.createElement('div');
    meta.className = 'r-meta';
    const status = document.createElement('span');
    status.textContent = hit.status === 'alive' ? '生' : hit.status === 'drifted' ? '漂流' : '閉幕';
    meta.appendChild(status);
    const date = document.createElement('span');
    date.textContent = fmtDate(hit.createdAtWall);
    meta.appendChild(date);
    if (hit.themeId) {
      const theme = themeById(hit.themeId);
      if (theme) {
        const link = document.createElement('span');
        link.className = 'r-theme-link';
        link.textContent = theme.name;
        link.addEventListener('click', () => {
          closeEcho();
          openBand(theme.id);
        });
        meta.appendChild(link);
      }
    }
    if (hit.closedNote) {
      const note = document.createElement('span');
      note.className = 'r-note';
      note.textContent = `「${hit.closedNote}」`;
      meta.appendChild(note);
    }

    // 行為: 生きていれば選択が移れる。どの縁ともリンク(細い幹)を張れる
    const act = (label: string, fn: () => void): void => {
      const a = document.createElement('span');
      a.className = 'r-act';
      a.textContent = label;
      a.addEventListener('click', fn);
      meta.appendChild(a);
    };
    if (hit.status === 'alive' && !isAwayComet(hit)) {
      act('選択', () => {
        closeEcho();
        setSelection([hit.id]);
      });
    }
    act('リンク', () => {
      if (echoTargetId) linkGrains(echoTargetId, hit.id);
      closeEcho();
    });
    div.appendChild(meta);

    if (hit.status !== 'alive') {
      const box = document.createElement('div');
      box.className = 'revive-box';
      const input = document.createElement('input');
      input.placeholder = 'なぜ戻すか(必須)';
      const go = document.createElement('span');
      go.className = 'revive-go';
      go.textContent = '蘇生';
      go.addEventListener('click', () => {
        if (revive(hit.id, input.value)) renderEcho();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) {
          e.preventDefault();
          if (revive(hit.id, input.value)) renderEcho();
        }
        if (e.key === 'Escape') e.stopPropagation();
      });
      box.appendChild(input);
      box.appendChild(go);
      div.appendChild(box);
    }

    elEchoResults.appendChild(div);
  }
}

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

  // スペース区切りはAND。本文・閉幕/蘇生の一言・テーマ名を横断する
  const terms = q.split(/[\s　]+/).filter(Boolean);
  const hits = state.grains
    .filter((g) => {
      const themeName = g.themeId ? (themeById(g.themeId)?.name ?? '') : '';
      const hay = `${g.text} ${g.closedNote ?? ''} ${g.revivedNote ?? ''} ${themeName}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    })
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
    if (g.cometReturnAtWall != null) {
      const note = document.createElement('span');
      note.className = 'r-note';
      note.textContent = `彗星 ・帰還 ${fmtDate(g.cometReturnAtWall)}${g.cometPeriodDays ? ` ・毎${g.cometPeriodDays}日` : ''}`;
      meta.appendChild(note);
    } else if (g.cometPeriodDays) {
      const note = document.createElement('span');
      note.className = 'r-note';
      note.textContent = `周期彗星 ・毎${g.cometPeriodDays}日`;
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
            persistState();
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
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) {
    e.preventDefault();
    undoClose();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || typing) return;

  if (e.key === 'Escape') {
    // 段階後退: 残響 → 検索/帯 → 選択
    if (echoTargetId) {
      closeEcho();
    } else if (searchOpen) {
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
  // Enterでも入力欄が開く
  if (e.key === 'Enter') {
    e.preventDefault();
    if (!writerMode) openWriter(inferWriteMode());
    elWriterInput.focus();
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
  ensureAngles(state);
  eco = state.ecoSeconds;
  selection = [];
  closeBand();
  closeSearch();
  sky.onSelectionChanged([]);
  checkCometReturns();
  cull(state, eco, Date.now());
  persistState();
  render();
  (e.target as HTMLInputElement).value = '';
});

// ---------- サンプルデータ ----------
function loadSample(needConfirm: boolean): void {
  if (needConfirm && state.grains.length > 0) {
    if (!window.confirm('現在のデータをサンプルで置き換えます。よろしいですか?(先に「書き出し」で退避できます)')) return;
  }
  state = buildSampleState();
  ensureAngles(state);
  eco = state.ecoSeconds;
  selection = [];
  closeBand();
  closeSearch();
  sky.onSelectionChanged([]);
  checkCometReturns();
  cull(state, eco, Date.now());
  persistState();
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

// ============================================================
// 保存とローカルサーバ(射出台)
// ============================================================

// 保存の一元化: localStorage(常時) + ローカルサーバ(届くときだけ、静かに)
function persistState(): void {
  state.ecoSeconds = eco;
  saveState(state);
  pushServerState();
}

let serverMode = false;
let pushTimer: number | null = null;

function pushServerState(): void {
  if (!serverMode) return;
  if (pushTimer !== null) clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => {
    fetch('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    }).catch(() => {});
  }, 800);
}

// サーバが居れば同期モードへ。サーバ側の空が進んでいれば乗り換える
async function initServer(): Promise<void> {
  try {
    const res = await fetch('/api/state');
    serverMode = true;
    if (res.ok) {
      const remote = parseImportedJson(await res.text());
      if (remote && remote.ecoSeconds > state.ecoSeconds) {
        state = remote;
        ensureAngles(state);
        eco = state.ecoSeconds;
        checkCometReturns();
        cull(state, eco, Date.now());
        render();
      }
    }
    persistState();
    await pullLaunches();
  } catch {
    serverMode = false;
  }
}

// 射出台(スマホ)から打ち上がった粒を取り込む。帰還のたびに空に積もる
async function pullLaunches(): Promise<void> {
  if (!serverMode) return;
  try {
    const res = await fetch('/api/launches');
    if (!res.ok) return;
    const items: unknown = await res.json();
    if (!Array.isArray(items) || items.length === 0) return;
    for (const it of items) {
      const text = typeof (it as { text?: unknown })?.text === 'string' ? (it as { text: string }).text.trim() : '';
      if (!text) continue;
      const g = newGrain(text); // 全部無所属で打ち上げ(出先での分類判断は置かない)
      const wall = (it as { createdAtWall?: unknown }).createdAtWall;
      if (typeof wall === 'number') g.createdAtWall = wall;
    }
    await fetch('/api/launches/clear', { method: 'POST' });
    commit();
  } catch {
    /* サーバ不在は静かに無視 */
  }
}

window.addEventListener('focus', () => {
  void pullLaunches();
});

// 24時間ごとの自動バックアップ(データ消失は検証の致命傷)
function autoBackup(): void {
  const KEY = 'orbiter.lastBackupAtWall';
  const last = Number(localStorage.getItem(KEY) ?? 0);
  if (state.grains.length > 0 && Date.now() - last > 86400000) {
    exportJson(state);
    localStorage.setItem(KEY, String(Date.now()));
  }
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
  linkGrains,
  repositionGrain,
  isActive: () => true,
});
checkCometReturns(); // 不在中に帰還日を迎えた彗星を戻す
cull(state, eco, Date.now()); // 前回終了後の状態でも規律を守らせてから描画
persistState();
autoBackup();
void initServer();
render();
