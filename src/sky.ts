import { PARAMS as P } from './params';
import type { Grain, State } from './types';
import { displayedGrains, effectiveAge, isOpenQuestion, tierOf } from './ecosystem';

// 「今」の面のCanvas描画。
//
// 空の規律:
// - 各星は固有の角度を持つ。誕生・ドラッグでのみ決まり、他の星の出来事では動かない
// - 空全体が同じ角速度でゆっくり回る。星座は形を保つ
// - 星は点、文字はそのラベル。デフォルトは点の下・中央揃えだが、
//   他の星と被るときはラベルが右・左・上へ逃げる(被らないこと・読めることが最優先)
// - 打ち上げ=地表の上側から弧を描いて自分の軌道へ。突入=逆の弧で地表へ落ちる隕石
//
// ズームの連続体(俯瞰⇄地表):
// - 俯瞰では惑星はただの丸。ズームインすると惑星が沈み、地平線が画面下側(約7割の高さ)に固定される
// - 地表視点は「地表が下・空が上」で固定。ダイヤル(ドラッグ)を回すと、
//   頭上の星々と足元の断面(閉幕の堆積)が一緒に流れ、最近の思考を遡れる

export interface SkyHooks {
  getState(): State;
  getEco(): number;
  getSelection(): string[];
  setSelection(ids: string[]): void;
  openTheme(themeId: string): void;
  correct(grainId: string): void;
  closeGrain(grainId: string): void;
  linkGrains(childId: string, targetId: string): void;
  repositionGrain(grainId: string, angle: number): void;
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

type LayoutMode = 'below' | 'above' | 'right' | 'left';

const FONT_STACK = '"Hiragino Sans", "Yu Gothic UI", sans-serif';
const COLOR_FG = '216, 222, 233';
const COLOR_ACCENT = '229, 192, 123';
const COLOR_THEME = '138, 180, 216';
const COLOR_EMBER = '229, 192, 123';

function smoothstep(x: number, a: number, b: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}
function easeInOut(t: number): number {
  return t * t * (3 - 2 * t);
}
function lerpAngle(a: number, b: number, t: number): number {
  const d = ((((b - a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
  return a + d * t;
}

export class Sky {
  private ctx: CanvasRenderingContext2D;
  private zoom = 1;
  private manualRot = 0;
  private animT = 0;
  private lastFrame = 0;
  private frameDt = 0;
  private drawn: DrawnItem[] = [];

  private refId: string | null = null;
  private refFrozenAngle = 0;
  private lastRefOffset = 0;

  private camX = 0;
  private camY = 0;

  private lastCenterX = 0;
  private lastCenterY = 0;
  private lastPlanetR = 0;

  private smoothClosed: number | null = null;

  private launchFx = new Map<string, number>();
  private entryFx: { angle0: number; r0: number; start: number }[] = [];
  private returnFx = new Map<string, number>(); // 彗星の帰還(外縁から滑り込む)
  private departFx: { angle0: number; r0: number; start: number }[] = []; // 彗星の出発(外へ遠ざかる)

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

  noteLaunch(grainId: string): void {
    this.launchFx.set(grainId, this.animT);
  }

  noteEntry(grainId: string): void {
    const pos = this.project(grainId);
    if (!pos) return;
    const angle0 = Math.atan2(pos.y - this.lastCenterY, pos.x - this.lastCenterX);
    const r0 = Math.hypot(pos.x - this.lastCenterX, pos.y - this.lastCenterY);
    this.entryFx.push({ angle0, r0, start: this.animT });
  }

  // 彗星の帰還: 外縁から尾を引いて滑り込む
  noteReturn(grainId: string): void {
    this.returnFx.set(grainId, this.animT);
  }

  // 彗星の出発: 現在位置から外へ遠ざかる
  noteDeparture(grainId: string): void {
    const pos = this.project(grainId);
    if (!pos) return;
    const angle0 = Math.atan2(pos.y - this.lastCenterY, pos.x - this.lastCenterX);
    const r0 = Math.hypot(pos.x - this.lastCenterX, pos.y - this.lastCenterY);
    this.departFx.push({ angle0, r0, start: this.animT });
  }

  // ---------- 力学 ----------

  private get omega(): number {
    return (2 * Math.PI) / P.SKY_ROTATION_PERIOD_SECONDS;
  }

  private currentAngle(g: Grain): number {
    return (g.angle ?? 0) + this.animT * this.omega;
  }

  // 地表の「上側」(惑星中心から画面中央方向)の角度
  private upAngle(cx: number, cy: number, cw: number, ch: number): number {
    return Math.atan2(ch / 2 - cy, cw / 2 - cx);
  }

  // ---------- 描画ループ ----------

  private frame = (t: number): void => {
    this.frameDt = this.lastFrame ? Math.min(0.1, (t - this.lastFrame) / 1000) : 0;
    this.lastFrame = t;
    if (!document.hidden && document.hasFocus()) this.animT += this.frameDt;
    if (this.hooks.isActive()) this.draw();
    requestAnimationFrame(this.frame);
  };

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
    const focusedId = selection.length === 1 ? selection[0] : null;

    // ---- 惑星の大きさ(突入でなめらかに育つ) ----
    const closedCount = state.grains.filter((g) => g.status === 'closed').length;
    if (this.smoothClosed === null) this.smoothClosed = closedCount;
    this.smoothClosed += (closedCount - this.smoothClosed) * (1 - Math.exp(-3 * this.frameDt));
    const planetBase = Math.min(short * 0.12, 26 + Math.sqrt(this.smoothClosed) * 4.5) * Math.min(this.zoom, 1.5);

    // ---- 地表への連続遷移 ----
    const surfaceT = smoothstep(this.zoom, P.SURFACE_START_ZOOM, P.SURFACE_FULL_ZOOM);
    const planetR = planetBase + (short * 1.5 - planetBase) * surfaceT;
    // 地平線を画面の約72%の高さに置く(地表の占有は下側3割弱)
    const surfaceOffset = surfaceT * (planetR + ch * 0.22);

    // 選択粒の星座の縁者
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
    // 半径: 俯瞰では画面比、地表では地平線の上の帯(空)に収める
    const rMinOver = Math.max(short * P.RADIUS_MIN_RATIO * Math.min(this.zoom, 1.5), planetBase + 34);
    const rMaxOver = short * P.RADIUS_MAX_RATIO * Math.min(this.zoom, 1.6);
    const rMin = rMinOver + (planetR + 52 - rMinOver) * surfaceT;
    const rMax = Math.max(rMaxOver + (planetR + ch * 0.56 - rMaxOver) * surfaceT, rMin + 140);

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

    // 打ち上げの出発点(前フレームの幾何でよい)
    const prevUp = this.upAngle(this.lastCenterX, this.lastCenterY, cw, ch);

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
      launching: number;
      x: number;
      y: number;
    }
    const pendings: Pending[] = [];

    const fontScale = Math.min(1.3, Math.max(0.8, Math.pow(this.zoom, 0.3)));
    const dotScale = Math.min(1.25, Math.max(0.7, Math.sqrt(this.zoom)));

    for (const g of grains) {
      const effAge = effectiveAge(g, eco);
      const frac = Math.min(1, effAge / P.SINK_AGE_SECONDS);
      const tier = tierOf(effAge);
      let angle = this.currentAngle(g) - refOffset + this.manualRot;
      let r = rMin + Math.pow(frac, 0.6) * (rMax - rMin);

      // 打ち上げ: 地表の上側から、ゆっくり弧を描いて自分の軌道へ
      let launching = 1;
      const fxStart = this.launchFx.get(g.id);
      if (fxStart !== undefined) {
        const e = (this.animT - fxStart) / 1.6;
        if (e >= 1) this.launchFx.delete(g.id);
        else {
          launching = Math.max(0, e);
          angle = lerpAngle(prevUp, angle, easeInOut(launching));
          r = planetR + 4 + (r - planetR - 4) * easeOutCubic(launching);
        }
      }

      // 彗星の帰還: 外縁から弧を描いて自分の軌道へ滑り込む
      const retStart = this.returnFx.get(g.id);
      if (retStart !== undefined) {
        const e = (this.animT - retStart) / 1.6;
        if (e >= 1) this.returnFx.delete(g.id);
        else {
          launching = Math.min(launching, Math.max(0.15, e));
          angle = lerpAngle(angle + 0.5, angle, easeInOut(Math.max(0, e)));
          r = rMax + 90 + (r - rMax - 90) * easeOutCubic(Math.max(0, e));
        }
      }

      const focused = g.id === focusedId;
      const relative = relativeIds.has(g.id);

      let fontPx = tier.fontSizePx * fontScale;
      let alpha = tier.opacity;
      let budget = Math.round((16 + 60 * (1 - frac)) * Math.min(this.zoom, 1.6));
      let maxLines = 3;
      if (focused) {
        fontPx = Math.max(fontPx, 16.5);
        alpha = 1;
        budget = Infinity;
        maxLines = 6;
      } else if (relative) {
        fontPx = Math.max(fontPx, 12);
        alpha = Math.max(alpha, 0.85);
        budget = Math.max(budget, 34);
      }
      if (launching < 1) alpha *= 0.35 + 0.65 * launching;
      const textOnly = focused || relative || !(fontPx < 8 || budget < 4);

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
        dotR: (2.5 + 3 * (1 - frac)) * dotScale,
        launching,
        x: 0,
        y: 0,
      });
    }

    // ---- カメラ ----
    let camTX = 0;
    let camTY = 0;
    if (focusedId) {
      const fp = pendings.find((p) => p.g.id === focusedId);
      if (fp) {
        camTX = -fp.relX;
        camTY = -fp.relY - surfaceOffset;
      }
    }
    const k = 1 - Math.exp(-6 * this.frameDt);
    this.camX += (camTX - this.camX) * k;
    this.camY += (camTY - this.camY) * k;

    const cx = cw / 2 + this.camX;
    const cy = ch / 2 + this.camY + surfaceOffset;
    this.lastCenterX = cx;
    this.lastCenterY = cy;
    this.lastPlanetR = planetR;
    const up = this.upAngle(cx, cy, cw, ch);

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
    const dropThreshold = planetR + Math.min(planetR * 0.4, 26);
    const draggingOverPlanet =
      this.pointerMode === 'grain' &&
      this.dragMoved &&
      Math.hypot(this.dragX - cx, this.dragY - cy) <= dropThreshold;

    const grad = ctx.createRadialGradient(cx - planetR * 0.3, cy - planetR * 0.35, planetR * 0.1, cx, cy, planetR);
    grad.addColorStop(0, '#3a4258');
    grad.addColorStop(0.45, '#2a3040');
    grad.addColorStop(0.8, '#1a1f2c');
    grad.addColorStop(1, '#12161f');
    ctx.beginPath();
    ctx.arc(cx, cy, planetR, 0, 2 * Math.PI);
    ctx.fillStyle = grad;
    ctx.fill();

    if (surfaceT > 0.05) {
      ctx.beginPath();
      ctx.arc(cx, cy, planetR, 0, 2 * Math.PI);
      ctx.strokeStyle = `rgba(150, 170, 210, ${0.15 * surfaceT})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // ---- 断面(考古学): 閉幕の堆積が円周に沿って眠る。ダイヤルで遡れる ----
    const dotsAlpha = smoothstep(surfaceT, 0.15, 0.5);
    const textAlpha = smoothstep(surfaceT, 0.7, 0.95);
    if (dotsAlpha > 0.01) {
      const buried = state.grains
        .filter((g) => g.status === 'closed')
        .sort((a, b) => (b.closedAtWall ?? b.createdAtWall) - (a.closedAtWall ?? a.createdAtWall))
        .slice(0, 80);
      // 新しいものほど「上」に近く、遡るほど円周を後ろへ。空と同じ回転に乗る
      const spacing = textAlpha > 0.02 ? 0.17 : 0.07;
      buried.forEach((g, i) => {
        const ba = up - (i + 0.6) * spacing + this.manualRot - refOffset + this.animT * this.omega * 0.0; // 断面はダイヤルにのみ従う
        const angle = ba;
        const depth = 42 + i * 2.5;
        if (depth + 10 > planetR) return;
        const rr = planetR - depth;
        const bx = cx + rr * Math.cos(angle);
        const by = cy + rr * Math.sin(angle);
        if (bx < -60 || bx > cw + 60 || by < -60 || by > ch + 60) return;

        ctx.beginPath();
        ctx.arc(bx, by, 2.2, 0, 2 * Math.PI);
        ctx.fillStyle = `rgba(${COLOR_EMBER}, ${0.32 * dotsAlpha})`;
        ctx.fill();

        if (textAlpha > 0.02) {
          ctx.font = `12px ${FONT_STACK}`;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = `rgba(196, 188, 170, ${0.62 * textAlpha})`;
          const label = clipText(g.text, 22);
          ctx.fillText(label, bx + 8, by);
          if (g.closedNote) {
            const w = ctx.measureText(label).width;
            ctx.fillStyle = `rgba(${COLOR_EMBER}, ${0.4 * textAlpha})`;
            ctx.fillText(`「${clipText(g.closedNote, 16)}」`, bx + 8 + w + 8, by);
          }
        }
      });
    }

    // 光暈
    const haloAlpha = draggingOverPlanet ? 0.22 : 0.08;
    const haloR = planetR + Math.min(planetR * 0.35, 64) * (draggingOverPlanet ? 1.7 : 1);
    ctx.beginPath();
    ctx.arc(cx, cy, haloR, 0, 2 * Math.PI);
    const halo = ctx.createRadialGradient(cx, cy, planetR, cx, cy, haloR);
    halo.addColorStop(0, `rgba(100,120,170,${haloAlpha})`);
    halo.addColorStop(1, 'rgba(100,120,170,0)');
    ctx.fillStyle = halo;
    ctx.fill();

    // ---- 星座の常設線 ----
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

    // ---- テーマの尾 ----
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
        const ta = p.angle - (idx + 1) * 0.05;
        const tr = p.r + (idx + 1) * 10;
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

    // ---- 粒(星+逃げられるラベル) ----
    this.drawn = [];
    const placedRects: Bounds[] = [];
    const GAP = 4;
    const overlaps = (a: Bounds) =>
      placedRects.some((b) => a.l < b.r + GAP && b.l < a.r + GAP && a.t < b.b + GAP && b.t < a.b + GAP);

    const orderedPendings = [...pendings].sort((a, b) => {
      const pa = a.focused ? 2 : a.relative ? 1 : 0;
      const pb = b.focused ? 2 : b.relative ? 1 : 0;
      return pb - pa;
    });

    const layouts: { mode: LayoutMode; dx: number }[] = [
      { mode: 'below', dx: 0 },
      { mode: 'right', dx: 0 },
      { mode: 'left', dx: 0 },
      { mode: 'above', dx: 0 },
      { mode: 'below', dx: 44 },
      { mode: 'below', dx: -44 },
      { mode: 'above', dx: 44 },
      { mode: 'above', dx: -44 },
    ];

    for (const p of orderedPendings) {
      let bounds: Bounds;
      let chosen: { mode: LayoutMode; dx: number } = layouts[0];

      if (p.textOnly) {
        const text = p.g.text.length > p.budget ? p.g.text.slice(0, p.budget) + '…' : p.g.text;
        let placed = false;
        while (true) {
          ctx.font = `${p.fontPx}px ${FONT_STACK}`;
          const maxLineW = p.focused ? Math.min(460, cw * 0.6) : Math.min(360, Math.max(150, 240 * fontScale));
          p.lines = wrapText(ctx, text, maxLineW, p.maxLines);
          const maxW = Math.max(...p.lines.map((l) => ctx.measureText(l).width), 1);
          const nameH = p.themeName ? Math.max(9.5, p.fontPx * 0.62) * 1.5 : 0;
          const blockH = nameH + p.lines.length * p.fontPx * 1.42;

          const candidates = p.focused ? [layouts[0]] : layouts;
          for (const cand of candidates) {
            const block = blockRect(p.x, p.y, p.dotR, maxW, blockH, cand);
            bounds = {
              l: Math.min(block.l, p.x - p.dotR - 2),
              t: Math.min(block.t, p.y - p.dotR - 2),
              r: Math.max(block.r, p.x + p.dotR + 2),
              b: Math.max(block.b, p.y + p.dotR + 2),
            };
            if (p.focused || !overlaps(bounds)) {
              chosen = cand;
              placed = true;
              break;
            }
          }
          if (placed || p.fontPx <= P.OVERLAP_MIN_FONT_PX) {
            if (!placed) {
              // 最後まで逃げ場がなければデフォルト位置で置く(最小フォント)
              const block = blockRect(p.x, p.y, p.dotR, maxW, blockH, layouts[0]);
              bounds = {
                l: Math.min(block.l, p.x - p.dotR - 2),
                t: Math.min(block.t, p.y - p.dotR - 2),
                r: Math.max(block.r, p.x + p.dotR + 2),
                b: Math.max(block.b, p.y + p.dotR + 2),
              };
              chosen = layouts[0];
            }
            break;
          }
          p.fontPx = Math.max(P.OVERLAP_MIN_FONT_PX, p.fontPx * P.OVERLAP_SHRINK_FACTOR);
        }
      } else {
        bounds = { l: p.x - p.dotR - 2, t: p.y - p.dotR - 2, r: p.x + p.dotR + 2, b: p.y + p.dotR + 2 };
      }
      placedRects.push(bounds!);

      const rgb = p.question ? COLOR_ACCENT : COLOR_FG;
      const alpha = p.selected ? 1 : p.alpha;

      // 打ち上げの航跡
      if (p.launching < 1) {
        const dirX = (p.x - cx) / Math.max(1, Math.hypot(p.x - cx, p.y - cy));
        const dirY = (p.y - cy) / Math.max(1, Math.hypot(p.x - cx, p.y - cy));
        const trail = 22 * (1 - p.launching);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - dirX * trail, p.y - dirY * trail);
        ctx.strokeStyle = `rgba(${rgb}, ${0.35 * (1 - p.launching)})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      if (p.selected) {
        ctx.shadowColor = `rgba(${rgb}, 0.9)`;
        ctx.shadowBlur = 12;
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.dotR, 0, 2 * Math.PI);
      ctx.fillStyle = `rgba(${rgb}, ${Math.max(alpha, 0.5)})`;
      ctx.fill();
      ctx.shadowBlur = 0;

      // 帰還してまだ触られていない彗星は尾を引く(触れば捕獲=尾が消える)
      if (p.g.cometTail) {
        const dLen = Math.max(1, Math.hypot(p.x - cx, p.y - cy));
        const ox = (p.x - cx) / dLen;
        const oy = (p.y - cy) / dLen;
        const tail = 18 + p.dotR * 2;
        const tg = ctx.createLinearGradient(p.x, p.y, p.x + ox * tail, p.y + oy * tail);
        tg.addColorStop(0, `rgba(${COLOR_FG}, 0.55)`);
        tg.addColorStop(1, `rgba(${COLOR_FG}, 0)`);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + ox * tail, p.y + oy * tail);
        ctx.strokeStyle = tg;
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }

      let themeRect: DrawnItem['themeRect'];

      if (p.textOnly) {
        ctx.font = `${p.fontPx}px ${FONT_STACK}`;
        const maxW = Math.max(...p.lines.map((l) => ctx.measureText(l).width), 1);
        const nameFont = Math.max(9.5, p.fontPx * 0.62);
        const nameH = p.themeName ? nameFont * 1.5 : 0;
        const blockH = nameH + p.lines.length * p.fontPx * 1.42;
        const block = blockRect(p.x, p.y, p.dotR, maxW, blockH, chosen);

        const align: CanvasTextAlign = chosen.mode === 'right' ? 'left' : chosen.mode === 'left' ? 'right' : 'center';
        const anchorX = chosen.mode === 'right' ? block.l : chosen.mode === 'left' ? block.r : (block.l + block.r) / 2;

        ctx.textAlign = align;
        ctx.textBaseline = 'top';
        let ly = block.t;
        if (p.themeName && p.g.themeId) {
          ctx.font = `${nameFont}px ${FONT_STACK}`;
          ctx.fillStyle = `rgba(${COLOR_THEME}, ${Math.min(1, alpha + 0.15)})`;
          ctx.fillText(p.themeName, anchorX, ly);
          const w = ctx.measureText(p.themeName).width;
          const nx = align === 'left' ? anchorX : align === 'right' ? anchorX - w : anchorX - w / 2;
          themeRect = { x: nx, y: ly, w, h: nameFont * 1.4, themeId: p.g.themeId };
          ly += nameFont * 1.5;
        }
        ctx.font = `${p.fontPx}px ${FONT_STACK}`;
        ctx.fillStyle = `rgba(${rgb}, ${alpha})`;
        for (const line of p.lines) {
          ctx.fillText(line, anchorX, ly);
          ly += p.fontPx * 1.42;
        }
      } else if (p.themeName && p.g.themeId) {
        const nameFont = Math.max(9.5, 10 * fontScale);
        ctx.font = `${nameFont}px ${FONT_STACK}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = `rgba(${COLOR_THEME}, 0.75)`;
        ctx.fillText(p.themeName, p.x, p.y + p.dotR + 3);
        const w = ctx.measureText(p.themeName).width;
        themeRect = { x: p.x - w / 2, y: p.y + p.dotR + 3, w, h: nameFont * 1.3, themeId: p.g.themeId };
      }

      this.drawn.push({ g: p.g, dotX: p.x, dotY: p.y, bounds: bounds!, themeRect });
    }

    // ---- 軌道上の彗星: 全天まで引いたときだけ、外縁の遠くに見える ----
    const rimAlpha = smoothstep(0.72 - this.zoom, 0, 0.2);
    if (rimAlpha > 0.01) {
      const away = state.grains.filter((g) => g.status === 'alive' && g.cometReturnAtWall != null);
      for (const g of away) {
        const angle = (g.angle ?? 0) + this.animT * this.omega - refOffset + this.manualRot;
        const rr = rMax + 36;
        const px = cx + rr * Math.cos(angle);
        const py = cy + rr * Math.sin(angle);
        const selectedAway = selection.includes(g.id);

        // 小さな氷の点と、外へ流れる微かな尾
        const tail = 12;
        const tg = ctx.createLinearGradient(px, py, px + Math.cos(angle) * tail, py + Math.sin(angle) * tail);
        tg.addColorStop(0, `rgba(${COLOR_FG}, ${0.4 * rimAlpha})`);
        tg.addColorStop(1, `rgba(${COLOR_FG}, 0)`);
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + Math.cos(angle) * tail, py + Math.sin(angle) * tail);
        ctx.strokeStyle = tg;
        ctx.lineWidth = 1.3;
        ctx.stroke();
        if (selectedAway) {
          ctx.shadowColor = `rgba(${COLOR_FG}, 0.9)`;
          ctx.shadowBlur = 10;
        }
        ctx.beginPath();
        ctx.arc(px, py, 2.1, 0, 2 * Math.PI);
        ctx.fillStyle = `rgba(${COLOR_FG}, ${(selectedAway ? 0.95 : 0.55) * rimAlpha})`;
        ctx.fill();
        ctx.shadowBlur = 0;

        let bounds: Bounds = { l: px - 8, t: py - 8, r: px + 8, b: py + 8 };
        if (selectedAway) {
          ctx.font = `11px ${FONT_STACK}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillStyle = `rgba(${COLOR_FG}, ${0.8 * rimAlpha})`;
          const label = clipText(g.text, 20);
          ctx.fillText(label, px, py + 7);
          ctx.font = `9.5px ${FONT_STACK}`;
          ctx.fillStyle = `rgba(${COLOR_ACCENT}, ${0.7 * rimAlpha})`;
          const when = fmtWall(g.cometReturnAtWall!);
          const periodText = g.cometPeriodDays ? ` ・毎${g.cometPeriodDays}日` : '';
          ctx.fillText(`帰還 ${when}${periodText}`, px, py + 22);
          const w = Math.max(ctx.measureText(label).width, 60);
          bounds = { l: px - w / 2, t: py - 8, r: px + w / 2, b: py + 34 };
        }
        this.drawn.push({ g, dotX: px, dotY: py, bounds });
      }
    }

    // ---- ドラッグ中: 落とし先の星にリング ----
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

    // ---- 突入: 弧を描いて地表の上側へ落ちる隕石 ----
    this.entryFx = this.entryFx.filter((fx) => {
      const e = (this.animT - fx.start) / 1.3;
      if (e >= 1) return false;

      const travel = Math.min(1, e / 0.68);
      const ang = lerpAngle(fx.angle0, up, easeInOut(travel));
      const rr = fx.r0 + (planetR - fx.r0) * (travel * travel);
      const px = cx + rr * Math.cos(ang);
      const py = cy + rr * Math.sin(ang);

      if (travel < 1) {
        // 進行方向の後ろへ燃える尾
        const back = lerpAngle(fx.angle0, up, easeInOut(Math.max(0, travel - 0.06)));
        const br = fx.r0 + (planetR - fx.r0) * Math.pow(Math.max(0, travel - 0.06), 2);
        const bx = cx + br * Math.cos(back);
        const by = cy + br * Math.sin(back);
        const tg = ctx.createLinearGradient(px, py, bx, by);
        tg.addColorStop(0, `rgba(${COLOR_EMBER}, 0.9)`);
        tg.addColorStop(1, `rgba(${COLOR_EMBER}, 0)`);
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(bx, by);
        ctx.strokeStyle = tg;
        ctx.lineWidth = 2.2;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(px, py, 2.8, 0, 2 * Math.PI);
        ctx.fillStyle = 'rgba(255, 226, 178, 0.95)';
        ctx.fill();
      } else {
        // 衝突: 地表で燐光がふくらんで消える
        const fe2 = (e - 0.68) / 0.32;
        const ix = cx + planetR * Math.cos(up);
        const iy = cy + planetR * Math.sin(up);
        const glowR = 12 + 34 * fe2;
        const ga = 0.55 * (1 - fe2);
        const g2 = ctx.createRadialGradient(ix, iy, 0, ix, iy, glowR);
        g2.addColorStop(0, `rgba(${COLOR_EMBER}, ${ga})`);
        g2.addColorStop(1, `rgba(${COLOR_EMBER}, 0)`);
        ctx.beginPath();
        ctx.arc(ix, iy, glowR, 0, 2 * Math.PI);
        ctx.fillStyle = g2;
        ctx.fill();
      }
      return true;
    });

    // ---- 彗星の出発(外へ遠ざかり、見えなくなる) ----
    this.departFx = this.departFx.filter((fx) => {
      const e = (this.animT - fx.start) / 1.4;
      if (e >= 1) return false;
      const ang = fx.angle0 + 0.35 * easeInOut(e);
      const rr = fx.r0 + (rMax + 140 - fx.r0) * (e * e);
      const px = cx + rr * Math.cos(ang);
      const py = cy + rr * Math.sin(ang);
      const a = 0.7 * (1 - e);
      // 惑星側へ流れる尾(遠ざかる背中)
      const back = fx.angle0 + 0.35 * easeInOut(Math.max(0, e - 0.05));
      const br = fx.r0 + (rMax + 140 - fx.r0) * Math.pow(Math.max(0, e - 0.05), 2);
      const bx = cx + br * Math.cos(back);
      const by = cy + br * Math.sin(back);
      const tg = ctx.createLinearGradient(px, py, bx, by);
      tg.addColorStop(0, `rgba(${COLOR_FG}, ${a})`);
      tg.addColorStop(1, `rgba(${COLOR_FG}, 0)`);
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(bx, by);
      ctx.strokeStyle = tg;
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(px, py, 2.2, 0, 2 * Math.PI);
      ctx.fillStyle = `rgba(${COLOR_FG}, ${a})`;
      ctx.fill();
      return true;
    });

    // ---- 星座の召喚 ----
    if (focusedId) {
      const sel = this.drawn.find((d) => d.g.id === focusedId && !d.phantom);
      if (sel) this.drawConstellation(sel, state, cx, cy);
    }
  }

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
        const dropThreshold = this.lastPlanetR + Math.min(this.lastPlanetR * 0.4, 26);
        if (Math.hypot(e.offsetX - this.lastCenterX, e.offsetY - this.lastCenterY) <= dropThreshold) {
          this.hooks.closeGrain(grainId);
          return;
        }
        const target = this.findGrainAt(e.offsetX, e.offsetY, grainId);
        if (target) {
          this.hooks.linkGrains(grainId, target.g.id);
          return;
        }
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

// ラベルブロックの矩形。mode: 星に対するラベルの逃げ方向
function blockRect(
  x: number,
  y: number,
  dotR: number,
  w: number,
  h: number,
  layout: { mode: LayoutMode; dx: number },
): Bounds {
  switch (layout.mode) {
    case 'below':
      return { l: x + layout.dx - w / 2, t: y + dotR + 4, r: x + layout.dx + w / 2, b: y + dotR + 4 + h };
    case 'above':
      return { l: x + layout.dx - w / 2, t: y - dotR - 4 - h, r: x + layout.dx + w / 2, b: y - dotR - 4 };
    case 'right':
      return { l: x + dotR + 7, t: y - h / 2, r: x + dotR + 7 + w, b: y + h / 2 };
    case 'left':
      return { l: x - dotR - 7 - w, t: y - h / 2, r: x - dotR - 7, b: y + h / 2 };
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

function fmtWall(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
