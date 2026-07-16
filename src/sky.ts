import { PARAMS as P } from './params';
import type { Grain, State } from './types';
import { displayedGrains, effectiveAge, isOpenQuestion, tierOf } from './ecosystem';

// 「今」の面のCanvas描画。
//
// 空の規律:
// - 各星は固有の角度(g.angle)を持つ。誕生・ドラッグでのみ決まり、他の星の出来事では動かない
// - 空全体が同じ角速度でゆっくり回る。星座は形を保つ
// - 温度は半径(外へ沈む)と文字の大きさ・濃さで表現される
// - リンク(幹・細い幹・付箋)で繋がった表示中の星同士は淡い線で結ばれ、星座に見える
// - 星を星に落とす=細い幹を張り、そのそばに移る。惑星に落とす=突入(閉幕)
// - 選択した粒の星座は明るく召喚され、軌道上にいない縁者は幻影として現れる

export interface SkyHooks {
  getState(): State;
  getEco(): number;
  getSelection(): string[];
  setSelection(ids: string[]): void;
  openTheme(themeId: string): void;
  correct(grainId: string): void;
  closeGrain(grainId: string): void;
  linkGrains(childId: string, targetId: string): void; // 細い幹を張る(ドラッグドロップ)
  repositionGrain(grainId: string, angle: number): void; // 角度の調整(ドラッグ)
  isActive(): boolean;
}

interface Bounds {
  l: number;
  t: number;
  r: number;
  b: number;
}

interface DrawnItem {
  g: Grain;
  dotX: number;
  dotY: number;
  bounds: Bounds;
  themeRect?: { x: number; y: number; w: number; h: number; themeId: string };
  phantom?: boolean;
}

const FONT_STACK = '"Hiragino Sans", "Yu Gothic UI", sans-serif';
const COLOR_FG = '216, 222, 233';
const COLOR_ACCENT = '229, 192, 123';
const COLOR_THEME = '138, 180, 216';

export class Sky {
  private ctx: CanvasRenderingContext2D;
  private zoom = 1;
  private manualRot = 0;
  private animT = 0; // フォーカス中だけ進む(不在中は空も凍結)
  private lastFrame = 0;
  private frameDt = 0;
  private drawn: DrawnItem[] = [];

  // 参照系(乗ると空の回転が止まって見える)
  private refId: string | null = null;
  private refFrozenAngle = 0;
  private lastRefOffset = 0;

  // フォーカスのカメラ。保存しない=視点は揮発
  private camX = 0;
  private camY = 0;

  // 直近フレームの幾何(入力処理用)
  private lastCenterX = 0;
  private lastCenterY = 0;
  private lastPlanetR = 0;

  // 入力状態
  private pointerMode: 'none' | 'dial' | 'grain' = 'none';
  private dragMoved = false;
  private downAngle = 0;
  private downRot = 0;
  private downX = 0;
  private downY = 0;
  private dragGrainId: string | null = null;
  private dragX = 0;
  private dragY = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private hooks: SkyHooks,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.bindEvents();
    requestAnimationFrame(this.frame);
  }

  onSelectionChanged(ids: string[]): void {
    if (ids.length === 0) {
      this.refId = null;
      return;
    }
    const id = ids[0];
    if (this.refId === id) return;
    const g = this.hooks.getState().grains.find((x) => x.id === id);
    if (g && typeof g.angle === 'number') {
      this.refId = id;
      this.refFrozenAngle = this.currentAngle(g);
    } else {
      this.refId = null;
    }
  }

  project(grainId: string): { x: number; y: number } | null {
    const item = this.drawn.find((d) => d.g.id === grainId && !d.phantom);
    return item ? { x: item.dotX, y: item.dotY } : null;
  }

  // ---------- 力学 ----------

  private get omega(): number {
    return (2 * Math.PI) / P.SKY_ROTATION_PERIOD_SECONDS;
  }

  private currentAngle(g: Grain): number {
    return (g.angle ?? 0) + this.animT * this.omega;
  }

  // ---------- 描画ループ ----------

  private frame = (t: number): void => {
    this.frameDt = this.lastFrame ? Math.min(0.1, (t - this.lastFrame) / 1000) : 0;
    this.lastFrame = t;
    if (!document.hidden && document.hasFocus()) this.animT += this.frameDt;
    if (this.hooks.isActive()) this.draw();
    requestAnimationFrame(this.frame);
  };

  private planetRadius(short: number, state: State): number {
    const closedCount = state.grains.filter((g) => g.status === 'closed').length;
    return Math.min(short * 0.1, 22 + Math.sqrt(closedCount) * 4) * this.zoom;
  }

  private draw(): void {
    const dpr = window.devicePixelRatio || 1;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (cw === 0 || ch === 0) return;
    if (this.canvas.width !== Math.round(cw * dpr) || this.canvas.height !== Math.round(ch * dpr)) {
      this.canvas.width = Math.round(cw * dpr);
      this.canvas.height = Math.round(ch * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    const state = this.hooks.getState();
    const eco = this.hooks.getEco();
    const selection = this.hooks.getSelection();
    const short = Math.min(cw, ch);
    const planetRBase = this.planetRadius(short, state);
    const focusedId = selection.length === 1 ? selection[0] : null;

    // 選択粒の星座の縁者(文字を濃く読みやすくする対象)
    const relativeIds = new Set<string>();
    if (focusedId) {
      const fg = state.grains.find((g) => g.id === focusedId);
      if (fg) {
        for (const pid of fg.parentIds) relativeIds.add(pid);
        for (const lid of fg.linkIds ?? []) relativeIds.add(lid);
        for (const s of state.grains) {
          if (s.attachedToId === fg.id) relativeIds.add(s.id);
          if ((s.linkIds ?? []).includes(fg.id)) relativeIds.add(s.id);
        }
      }
    }

    // ---- 位置の事前計算 ----
    const grains = displayedGrains(state, eco).sort((a, b) => b.lastTouchEco - a.lastTouchEco);
    const rMin = Math.max(short * P.RADIUS_MIN_RATIO * this.zoom, planetRBase + 34);
    const rMax = short * P.RADIUS_MAX_RATIO * this.zoom;

    let refOffset = 0;
    if (this.refId) {
      const rg = state.grains.find((x) => x.id === this.refId);
      if (rg && grains.some((x) => x.id === this.refId)) {
        refOffset = this.currentAngle(rg) - this.refFrozenAngle;
      } else {
        this.refId = null;
      }
    }
    this.lastRefOffset = refOffset;

    interface Pending {
      g: Grain;
      relX: number;
      relY: number;
      angle: number;
      r: number;
      fontPx: number;
      alpha: number;
      lines: string[];
      textOnly: boolean;
      maxLines: number;
      budget: number;
      themeName?: string;
      selected: boolean;
      focused: boolean;
      relative: boolean;
      question: boolean;
      frac: number;
      dotR: number;
      x: number;
      y: number;
    }
    const pendings: Pending[] = [];

    for (const g of grains) {
      const effAge = effectiveAge(g, eco);
      const frac = Math.min(1, effAge / P.SINK_AGE_SECONDS);
      const tier = tierOf(effAge);
      const angle = this.currentAngle(g) - refOffset + this.manualRot;
      const r = rMin + Math.pow(frac, 0.6) * (rMax - rMin);

      const focused = g.id === focusedId;
      const relative = relativeIds.has(g.id);

      let fontPx = tier.fontSizePx * Math.pow(this.zoom, 0.9);
      let alpha = tier.opacity;
      let budget = Math.round((14 + 60 * (1 - frac)) * this.zoom);
      let maxLines = 3;
      if (focused) {
        fontPx = Math.max(fontPx, 16);
        alpha = 1;
        budget = Infinity;
        maxLines = 6;
      } else if (relative) {
        fontPx = Math.max(fontPx, 11.5);
        alpha = Math.max(alpha, 0.85);
        budget = Math.max(budget, 34);
      }
      const textOnly = focused || relative || !(fontPx < 7 || budget < 4);

      const theme = g.themeId ? state.themes.find((t) => t.id === g.themeId) : undefined;
      pendings.push({
        g,
        relX: r * Math.cos(angle),
        relY: r * Math.sin(angle),
        angle,
        r,
        fontPx,
        alpha,
        lines: [],
        textOnly,
        maxLines,
        budget,
        themeName: theme?.name,
        selected: selection.includes(g.id),
        focused,
        relative,
        question: isOpenQuestion(g),
        frac,
        dotR: (2 + 2.5 * (1 - frac)) * Math.sqrt(Math.max(this.zoom, 0.4)),
        x: 0,
        y: 0,
      });
    }

    // ---- カメラ: フォーカス粒を画面中心へ(視点は揮発) ----
    let camTX = 0;
    let camTY = 0;
    if (focusedId) {
      const fp = pendings.find((p) => p.g.id === focusedId);
      if (fp) {
        camTX = -fp.relX;
        camTY = -fp.relY;
      }
    }
    const k = 1 - Math.exp(-6 * this.frameDt);
    this.camX += (camTX - this.camX) * k;
    this.camY += (camTY - this.camY) * k;

    const cx = cw / 2 + this.camX;
    const cy = ch / 2 + this.camY;
    this.lastCenterX = cx;
    this.lastCenterY = cy;
    this.lastPlanetR = planetRBase;

    const byId = new Map<string, Pending>();
    for (const p of pendings) {
      p.x = cx + p.relX;
      p.y = cy + p.relY;
      if (this.pointerMode === 'grain' && this.dragMoved && this.dragGrainId === p.g.id) {
        p.x = this.dragX;
        p.y = this.dragY;
      }
      byId.set(p.g.id, p);
    }

    // ---- 惑星 ----
    const draggingOverPlanet =
      this.pointerMode === 'grain' &&
      this.dragMoved &&
      Math.hypot(this.dragX - cx, this.dragY - cy) <= planetRBase * 1.4;

    const grad = ctx.createRadialGradient(
      cx - planetRBase * 0.3,
      cy - planetRBase * 0.35,
      planetRBase * 0.1,
      cx,
      cy,
      planetRBase,
    );
    grad.addColorStop(0, '#3a4258');
    grad.addColorStop(0.45, '#2a3040');
    grad.addColorStop(0.8, '#1a1f2c');
    grad.addColorStop(1, '#12161f');
    ctx.beginPath();
    ctx.arc(cx, cy, planetRBase, 0, 2 * Math.PI);
    ctx.fillStyle = grad;
    ctx.fill();
    const haloAlpha = draggingOverPlanet ? 0.22 : 0.08;
    const haloR = planetRBase * (draggingOverPlanet ? 1.6 : 1.35);
    ctx.beginPath();
    ctx.arc(cx, cy, haloR, 0, 2 * Math.PI);
    const halo = ctx.createRadialGradient(cx, cy, planetRBase, cx, cy, haloR);
    halo.addColorStop(0, `rgba(100,120,170,${haloAlpha})`);
    halo.addColorStop(1, 'rgba(100,120,170,0)');
    ctx.fillStyle = halo;
    ctx.fill();

    // ---- 星座の常設線: 表示中の星同士のリンク(幹・細い幹・付箋) ----
    ctx.lineWidth = 1;
    ctx.strokeStyle = `rgba(${COLOR_FG}, 0.12)`;
    const drawnPairs = new Set<string>();
    for (const p of pendings) {
      const targets = [...p.g.parentIds, ...(p.g.linkIds ?? [])];
      if (p.g.attachedToId) targets.push(p.g.attachedToId);
      for (const tid of targets) {
        const t = byId.get(tid);
        if (!t) continue;
        const key = p.g.id < tid ? `${p.g.id}|${tid}` : `${tid}|${p.g.id}`;
        if (drawnPairs.has(key)) continue;
        drawnPairs.add(key);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(t.x, t.y);
        ctx.stroke();
      }
    }

    // ---- テーマの尾(常設の点と線) ----
    for (const p of pendings) {
      if (!p.g.themeId) continue;
      const tail = state.grains
        .filter((t) => t.themeId === p.g.themeId && t.id !== p.g.id)
        .sort((a, b) => b.createdAtWall - a.createdAtWall)
        .slice(0, 6);
      if (tail.length === 0) continue;

      let prevX = p.x;
      let prevY = p.y;
      ctx.strokeStyle = `rgba(${COLOR_THEME}, 0.18)`;
      tail.forEach((t, idx) => {
        const ta = p.angle - (idx + 1) * 0.055;
        const tr = p.r + (idx + 1) * 9 * Math.sqrt(this.zoom);
        const tx = cx + tr * Math.cos(ta);
        const ty = cy + tr * Math.sin(ta);
        ctx.beginPath();
        ctx.moveTo(prevX, prevY);
        ctx.lineTo(tx, ty);
        ctx.stroke();
        const dead = t.status !== 'alive';
        ctx.beginPath();
        ctx.arc(tx, ty, 1.6, 0, 2 * Math.PI);
        ctx.fillStyle = `rgba(${COLOR_THEME}, ${dead ? 0.25 : 0.5})`;
        ctx.fill();
        prevX = tx;
        prevY = ty;
      });
    }

    // ---- 粒(星の下に中央揃えの文字) ----
    this.drawn = [];
    const placedRects: Bounds[] = [];
    const GAP = 4;
    const overlaps = (a: Bounds) =>
      placedRects.some((b) => a.l < b.r + GAP && b.l < a.r + GAP && a.t < b.b + GAP && b.t < a.b + GAP);

    const ordered = [...pendings].sort((a, b) => {
      const pa = a.focused ? 2 : a.relative ? 1 : 0;
      const pb = b.focused ? 2 : b.relative ? 1 : 0;
      return pb - pa;
    });

    for (const p of ordered) {
      let bounds: Bounds;
      if (p.textOnly) {
        const text = p.g.text.length > p.budget ? p.g.text.slice(0, p.budget) + '…' : p.g.text;
        while (true) {
          ctx.font = `${p.fontPx}px ${FONT_STACK}`;
          const maxLineW = p.focused ? Math.min(460, cw * 0.6) : Math.min(380, Math.max(130, 260 * this.zoom));
          p.lines = wrapText(ctx, text, maxLineW, p.maxLines);
          const maxW = Math.max(...p.lines.map((l) => ctx.measureText(l).width), p.dotR * 2);
          const nameH = p.themeName ? Math.max(9, p.fontPx * 0.62) * 1.5 : 0;
          const textH = p.lines.length * p.fontPx * 1.42;
          bounds = {
            l: p.x - maxW / 2,
            t: p.y - p.dotR - nameH - 2,
            r: p.x + maxW / 2,
            b: p.y + p.dotR + 4 + textH,
          };
          if (p.focused || !overlaps(bounds) || p.fontPx <= P.OVERLAP_MIN_FONT_PX) break;
          p.fontPx = Math.max(P.OVERLAP_MIN_FONT_PX, p.fontPx * P.OVERLAP_SHRINK_FACTOR);
        }
      } else {
        bounds = { l: p.x - p.dotR - 2, t: p.y - p.dotR - 2, r: p.x + p.dotR + 2, b: p.y + p.dotR + 2 };
      }
      placedRects.push(bounds!);

      const rgb = p.question ? COLOR_ACCENT : COLOR_FG;
      const alpha = p.selected ? 1 : p.alpha;

      if (p.selected) {
        ctx.shadowColor = `rgba(${rgb}, 0.9)`;
        ctx.shadowBlur = 12;
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.dotR, 0, 2 * Math.PI);
      ctx.fillStyle = `rgba(${rgb}, ${Math.max(alpha, 0.5)})`;
      ctx.fill();
      ctx.shadowBlur = 0;

      let themeRect: DrawnItem['themeRect'];
      ctx.textAlign = 'center';

      if (p.textOnly) {
        if (p.themeName && p.g.themeId) {
          const nameFont = Math.max(9, p.fontPx * 0.62);
          ctx.font = `${nameFont}px ${FONT_STACK}`;
          ctx.textBaseline = 'bottom';
          ctx.fillStyle = `rgba(${COLOR_THEME}, ${Math.min(1, alpha + 0.15)})`;
          const nameY = p.y - p.dotR - 4;
          ctx.fillText(p.themeName, p.x, nameY);
          const w = ctx.measureText(p.themeName).width;
          themeRect = { x: p.x - w / 2, y: nameY - nameFont * 1.2, w, h: nameFont * 1.4, themeId: p.g.themeId };
        }
        ctx.font = `${p.fontPx}px ${FONT_STACK}`;
        ctx.textBaseline = 'top';
        ctx.fillStyle = `rgba(${rgb}, ${alpha})`;
        const lineH = p.fontPx * 1.42;
        let ly = p.y + p.dotR + 4;
        for (const line of p.lines) {
          ctx.fillText(line, p.x, ly);
          ly += lineH;
        }
      } else if (p.themeName && p.g.themeId) {
        const nameFont = Math.max(9, 10 * this.zoom);
        ctx.font = `${nameFont}px ${FONT_STACK}`;
        ctx.textBaseline = 'top';
        ctx.fillStyle = `rgba(${COLOR_THEME}, 0.75)`;
        ctx.fillText(p.themeName, p.x, p.y + p.dotR + 3);
        const w = ctx.measureText(p.themeName).width;
        themeRect = { x: p.x - w / 2, y: p.y + p.dotR + 3, w, h: nameFont * 1.3, themeId: p.g.themeId };
      }

      this.drawn.push({ g: p.g, dotX: p.x, dotY: p.y, bounds: bounds!, themeRect });
    }

    // ---- ドラッグ中: 落とし先の星を淡くリング表示 ----
    if (this.pointerMode === 'grain' && this.dragMoved && this.dragGrainId) {
      const target = this.findGrainAt(this.dragX, this.dragY, this.dragGrainId);
      if (target) {
        ctx.beginPath();
        ctx.arc(target.dotX, target.dotY, 14, 0, 2 * Math.PI);
        ctx.strokeStyle = `rgba(${COLOR_FG}, 0.35)`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // ---- 星座の召喚(選択時のみ明るく) ----
    if (focusedId) {
      const sel = this.drawn.find((d) => d.g.id === focusedId && !d.phantom);
      if (sel) this.drawConstellation(sel, state, cx, cy);
    }
  }

  // 選択粒の幹・細い幹・付箋を明るい線で結ぶ。軌道上にいない縁者は幻影の星として召喚
  private drawConstellation(sel: DrawnItem, state: State, cx: number, cy: number): void {
    const ctx = this.ctx;
    const g = sel.g;
    const relatives: { grain: Grain; kind: string }[] = [];
    for (const pid of g.parentIds) {
      const p = state.grains.find((x) => x.id === pid);
      if (p) relatives.push({ grain: p, kind: '幹' });
    }
    for (const lid of g.linkIds ?? []) {
      const l = state.grains.find((x) => x.id === lid);
      if (l) relatives.push({ grain: l, kind: 'リンク' });
    }
    for (const s of state.grains) {
      if (s.attachedToId === g.id) relatives.push({ grain: s, kind: '付箋' });
      else if ((s.linkIds ?? []).includes(g.id)) relatives.push({ grain: s, kind: 'リンク' });
    }
    if (relatives.length === 0) return;

    const ux = sel.dotX - cx;
    const uy = sel.dotY - cy;
    const baseAngle = Math.atan2(uy, ux);
    const phantoms = relatives.filter((rel) => !this.drawn.some((d) => d.g.id === rel.grain.id && !d.phantom));
    let phantomIndex = 0;

    for (const rel of relatives) {
      const target = this.drawn.find((d) => d.g.id === rel.grain.id && !d.phantom);
      let tx: number;
      let ty: number;

      if (target) {
        tx = target.dotX;
        ty = target.dotY;
      } else {
        const m = phantoms.length;
        const spread = m > 1 ? -0.55 + (1.1 * phantomIndex) / (m - 1) : 0;
        const dist = 110 * Math.max(0.7, Math.min(this.zoom, 1.5)) + phantomIndex * 8;
        tx = sel.dotX + Math.cos(baseAngle + spread) * dist;
        ty = sel.dotY + Math.sin(baseAngle + spread) * dist;
        phantomIndex++;
      }

      const dead = rel.grain.status !== 'alive';
      const question = isOpenQuestion(rel.grain);
      const rgb = question ? COLOR_ACCENT : COLOR_FG;

      ctx.beginPath();
      ctx.moveTo(sel.dotX, sel.dotY);
      ctx.lineTo(tx, ty);
      ctx.strokeStyle = `rgba(${COLOR_FG}, ${dead ? 0.15 : 0.3})`;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.font = `9px ${FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = `rgba(${COLOR_FG}, 0.38)`;
      ctx.fillText(rel.kind, (sel.dotX + tx) / 2, (sel.dotY + ty) / 2 - 2);

      if (!target) {
        ctx.beginPath();
        ctx.arc(tx, ty, 2.4, 0, 2 * Math.PI);
        ctx.fillStyle = `rgba(${rgb}, ${dead ? 0.35 : 0.7})`;
        ctx.fill();

        const label =
          clipText(rel.grain.text, 24) +
          (rel.grain.status === 'drifted' ? ' ・漂流' : rel.grain.status === 'closed' ? ' ・閉幕' : '');
        ctx.font = `11px ${FONT_STACK}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = `rgba(${rgb}, ${dead ? 0.4 : 0.75})`;
        ctx.fillText(label, tx, ty + 6);
        const w = ctx.measureText(label).width;

        this.drawn.push({
          g: rel.grain,
          dotX: tx,
          dotY: ty,
          bounds: { l: tx - Math.max(w / 2, 8), t: ty - 8, r: tx + Math.max(w / 2, 8), b: ty + 20 },
          phantom: true,
        });
      }
    }
  }

  // ---------- 入力 ----------

  private bindEvents(): void {
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const next = this.zoom * Math.exp(-e.deltaY * 0.0012);
        this.zoom = Math.min(P.ZOOM_MAX, Math.max(P.ZOOM_MIN, next));
      },
      { passive: false },
    );

    this.canvas.addEventListener('pointerdown', (e) => {
      this.dragMoved = false;
      this.downX = e.offsetX;
      this.downY = e.offsetY;
      const hit = this.hitTest(e.offsetX, e.offsetY);
      if (hit?.grainId && !hit.phantom && hit.alive) {
        this.pointerMode = 'grain';
        this.dragGrainId = hit.grainId;
        this.dragX = e.offsetX;
        this.dragY = e.offsetY;
      } else {
        this.pointerMode = 'dial';
        this.downAngle = this.pointerAngle(e);
        this.downRot = this.manualRot;
      }
      this.canvas.setPointerCapture(e.pointerId);
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (this.pointerMode === 'none') return;
      if (!this.dragMoved && Math.hypot(e.offsetX - this.downX, e.offsetY - this.downY) > 5) {
        this.dragMoved = true;
      }
      if (this.pointerMode === 'dial') {
        if (this.dragMoved) this.manualRot = this.downRot + (this.pointerAngle(e) - this.downAngle);
      } else {
        this.dragX = e.offsetX;
        this.dragY = e.offsetY;
      }
    });

    this.canvas.addEventListener('pointerup', (e) => {
      const mode = this.pointerMode;
      const moved = this.dragMoved;
      const grainId = this.dragGrainId;
      this.pointerMode = 'none';
      this.dragGrainId = null;

      if (mode === 'grain' && moved && grainId) {
        // 惑星に落とす=突入(閉幕) / 星に落とす=細い幹を張り、そばへ移る / 空に落とす=角度の調整
        if (Math.hypot(e.offsetX - this.lastCenterX, e.offsetY - this.lastCenterY) <= this.lastPlanetR * 1.4) {
          this.hooks.closeGrain(grainId);
          return;
        }
        const target = this.findGrainAt(e.offsetX, e.offsetY, grainId);
        if (target) {
          this.hooks.linkGrains(grainId, target.g.id);
          return;
        }
        // 画面座標 → 保存する固有角度に逆変換
        const screenAngle = Math.atan2(e.offsetY - this.lastCenterY, e.offsetX - this.lastCenterX);
        const storedAngle = screenAngle - this.animT * this.omega + this.lastRefOffset - this.manualRot;
        this.hooks.repositionGrain(grainId, storedAngle);
        return;
      }
      if (moved) return;

      const hit = this.hitTest(e.offsetX, e.offsetY);
      const selection = this.hooks.getSelection();
      if (!hit) {
        if (selection.length > 0) this.hooks.setSelection([]);
        return;
      }
      if (hit.themeId) {
        this.hooks.openTheme(hit.themeId);
        return;
      }
      if (hit.phantom) {
        if (hit.alive && hit.grainId) this.hooks.setSelection([hit.grainId]);
        return;
      }
      const id = hit.grainId!;
      if (e.ctrlKey || e.metaKey) {
        this.hooks.setSelection(selection.includes(id) ? selection.filter((s) => s !== id) : [...selection, id]);
      } else {
        this.hooks.setSelection(selection.includes(id) && selection.length === 1 ? [] : [id]);
      }
    });

    this.canvas.addEventListener('dblclick', (e) => {
      const hit = this.hitTest(e.offsetX, e.offsetY);
      if (hit?.grainId) this.hooks.correct(hit.grainId);
    });
  }

  private pointerAngle(e: PointerEvent): number {
    return Math.atan2(e.offsetY - this.lastCenterY, e.offsetX - this.lastCenterX);
  }

  private findGrainAt(x: number, y: number, excludeId: string): DrawnItem | null {
    for (let i = this.drawn.length - 1; i >= 0; i--) {
      const d = this.drawn[i];
      if (d.phantom || d.g.id === excludeId) continue;
      const b = d.bounds;
      if (x >= b.l - 4 && x <= b.r + 4 && y >= b.t - 4 && y <= b.b + 4) return d;
    }
    return null;
  }

  private hitTest(
    x: number,
    y: number,
  ): { grainId?: string; themeId?: string; phantom?: boolean; alive?: boolean } | null {
    const PAD = 5;
    for (let i = this.drawn.length - 1; i >= 0; i--) {
      const d = this.drawn[i];
      if (d.themeRect) {
        const t = d.themeRect;
        if (x >= t.x - PAD && x <= t.x + t.w + PAD && y >= t.y - PAD && y <= t.y + t.h + PAD) {
          return { themeId: t.themeId };
        }
      }
      const b = d.bounds;
      if (x >= b.l - PAD && x <= b.r + PAD && y >= b.t - PAD && y <= b.b + PAD) {
        return { grainId: d.g.id, phantom: d.phantom, alive: d.g.status === 'alive' };
      }
    }
    return null;
  }
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const ch of text) {
    if (ctx.measureText(cur + ch).width > maxWidth && cur.length > 0) {
      lines.push(cur);
      cur = ch;
      if (lines.length === maxLines) {
        lines[maxLines - 1] = lines[maxLines - 1].slice(0, -1) + '…';
        return lines;
      }
    } else {
      cur += ch;
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, maxLines);
}

function clipText(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
