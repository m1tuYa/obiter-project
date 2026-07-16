import { PARAMS as P } from './params';
import type { Grain, State } from './types';
import { displayedGrains, effectiveAge, isOpenQuestion, tierOf } from './ecosystem';

// 「今」の面のCanvas描画。周回・ズーム・回転・参照系の乗り移り・星座を担う。
// 力学だけを借り、見た目は抽象に保つ。
//
// 星座の規律:
// - 粒は常に点(星)として存在し、文字はそのラベル
// - テーマの尾(代表粒の後ろの点と線)だけは常設 —— 周回モデルの部品表通り
// - それ以外の線は常設しない。選択した粒の幹・付箋のみが星座として召喚される

export interface SkyHooks {
  getState(): State;
  getEco(): number;
  getSelection(): string[];
  setSelection(ids: string[]): void;
  openTheme(themeId: string): void;
  correct(grainId: string): void;
  closeGrain(grainId: string): void; // 惑星への突入(ドラッグで落とす閉幕)
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
  phantom?: boolean; // 召喚された(軌道上にいない)幹・付箋
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
  private drawn: DrawnItem[] = [];

  // 参照系
  private refId: string | null = null;
  private refFrozenAngle = 0;

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
    const a = this.computeAngles().get(id);
    if (a !== undefined) {
      this.refId = id;
      this.refFrozenAngle = a;
    } else {
      this.refId = null;
    }
  }

  project(grainId: string): { x: number; y: number } | null {
    const item = this.drawn.find((d) => d.g.id === grainId && !d.phantom);
    return item ? { x: item.dotX, y: item.dotY } : null;
  }

  // ---------- 力学 ----------

  private orbitOmega(frac: number): number {
    const factor = 1 - frac * (1 - P.ORBIT_COLD_FACTOR);
    return ((2 * Math.PI) / P.ORBIT_PERIOD_HOT_SECONDS) * factor;
  }

  private computeAngles(): Map<string, number> {
    const state = this.hooks.getState();
    const eco = this.hooks.getEco();
    const grains = displayedGrains(state, eco).sort((a, b) => b.lastTouchEco - a.lastTouchEco);
    const n = Math.max(grains.length, 1);
    const map = new Map<string, number>();
    grains.forEach((g, i) => {
      const frac = Math.min(1, effectiveAge(g, eco) / P.SINK_AGE_SECONDS);
      const base = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      map.set(g.id, base + this.animT * this.orbitOmega(frac));
    });
    return map;
  }

  // ---------- 描画ループ ----------

  private frame = (t: number): void => {
    const dt = this.lastFrame ? Math.min(0.1, (t - this.lastFrame) / 1000) : 0;
    this.lastFrame = t;
    if (!document.hidden && document.hasFocus()) this.animT += dt;
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
    const cx = cw / 2;
    const cy = ch / 2;
    const short = Math.min(cw, ch);

    // ---- 惑星 ----
    const planetR = this.planetRadius(short, state);
    const draggingOverPlanet =
      this.pointerMode === 'grain' &&
      this.dragMoved &&
      Math.hypot(this.dragX - cx, this.dragY - cy) <= planetR * 1.4;

    const grad = ctx.createRadialGradient(cx - planetR * 0.3, cy - planetR * 0.35, planetR * 0.1, cx, cy, planetR);
    grad.addColorStop(0, '#3a4258');
    grad.addColorStop(0.45, '#2a3040');
    grad.addColorStop(0.8, '#1a1f2c');
    grad.addColorStop(1, '#12161f');
    ctx.beginPath();
    ctx.arc(cx, cy, planetR, 0, 2 * Math.PI);
    ctx.fillStyle = grad;
    ctx.fill();
    // 光暈。粒を掴んで上空に来ると微かに強まる(突入の予告)
    const haloAlpha = draggingOverPlanet ? 0.22 : 0.08;
    const haloR = planetR * (draggingOverPlanet ? 1.6 : 1.35);
    ctx.beginPath();
    ctx.arc(cx, cy, haloR, 0, 2 * Math.PI);
    const halo = ctx.createRadialGradient(cx, cy, planetR, cx, cy, haloR);
    halo.addColorStop(0, `rgba(100,120,170,${haloAlpha})`);
    halo.addColorStop(1, 'rgba(100,120,170,0)');
    ctx.fillStyle = halo;
    ctx.fill();

    // ---- 粒の位置計算 ----
    const grains = displayedGrains(state, eco).sort((a, b) => b.lastTouchEco - a.lastTouchEco);
    const n = Math.max(grains.length, 1);
    const rMin = Math.max(short * P.RADIUS_MIN_RATIO * this.zoom, planetR + 34);
    const rMax = short * P.RADIUS_MAX_RATIO * this.zoom;

    let refOffset = 0;
    if (this.refId) {
      const a = this.computeAngles().get(this.refId);
      if (a !== undefined) refOffset = a - this.refFrozenAngle;
      else this.refId = null;
    }

    interface Pending {
      g: Grain;
      x: number;
      y: number;
      angle: number;
      r: number;
      fontPx: number;
      alpha: number;
      lines: string[];
      textOnly: boolean;
      themeName?: string;
      selected: boolean;
      question: boolean;
      frac: number;
      dotR: number;
    }
    const pendings: Pending[] = [];

    grains.forEach((g, i) => {
      const effAge = effectiveAge(g, eco);
      const frac = Math.min(1, effAge / P.SINK_AGE_SECONDS);
      const tier = tierOf(effAge);
      const base = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      const angle = base + this.animT * this.orbitOmega(frac) - refOffset + this.manualRot;
      const r = rMin + Math.pow(frac, 0.6) * (rMax - rMin);
      let x = cx + r * Math.cos(angle);
      let y = cy + r * Math.sin(angle);

      // 掴まれている粒はポインタに従う(揮発的。離せば軌道に戻る)
      if (this.pointerMode === 'grain' && this.dragMoved && this.dragGrainId === g.id) {
        x = this.dragX;
        y = this.dragY;
      }

      const fontPx = tier.fontSizePx * Math.pow(this.zoom, 0.9);
      const budget = Math.round((14 + 60 * (1 - frac)) * this.zoom);
      const textOnly = !(fontPx < 7 || budget < 4); // falseなら点+テーマ名だけ
      const theme = g.themeId ? state.themes.find((t) => t.id === g.themeId) : undefined;

      pendings.push({
        g,
        x,
        y,
        angle,
        r,
        fontPx,
        alpha: tier.opacity,
        lines: [],
        textOnly,
        themeName: theme?.name,
        selected: selection.includes(g.id),
        question: isOpenQuestion(g),
        frac,
        dotR: (2 + 2.5 * (1 - frac)) * Math.sqrt(Math.max(this.zoom, 0.4)),
      });
    });

    // ---- テーマの尾(常設の点と線) ----
    ctx.lineWidth = 1;
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
      tail.forEach((t, k) => {
        // 尾は軌道の後方(角度の負方向)へ、わずかに外周寄りに引かれる
        const ta = p.angle - (k + 1) * 0.055;
        const tr = p.r + (k + 1) * 9 * Math.sqrt(this.zoom);
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

    // ---- 粒(星+ラベル)。熱い順に置き、重なったら冷たい側の文字を縮める ----
    this.drawn = [];
    const placedRects: Bounds[] = [];
    const GAP = 4;
    const overlaps = (a: Bounds) =>
      placedRects.some((b) => a.l < b.r + GAP && b.l < a.r + GAP && a.t < b.b + GAP && b.t < a.b + GAP);

    for (const p of pendings) {
      let bounds: Bounds;
      let maxW = 0;
      if (p.textOnly) {
        const budget = Math.round((14 + 60 * (1 - p.frac)) * this.zoom);
        const text = p.g.text.length > budget ? p.g.text.slice(0, budget) + '…' : p.g.text;
        while (true) {
          ctx.font = `${p.fontPx}px ${FONT_STACK}`;
          const maxLineW = Math.min(380, Math.max(130, 260 * this.zoom));
          p.lines = wrapText(ctx, text, maxLineW, 3);
          maxW = Math.max(...p.lines.map((l) => ctx.measureText(l).width), 1);
          const totalH = p.lines.length * p.fontPx * 1.4 + (p.themeName ? p.fontPx * 0.95 : 0);
          bounds = {
            l: p.x - p.dotR,
            t: p.y - totalH / 2,
            r: p.x + p.dotR + 6 + maxW,
            b: p.y + totalH / 2,
          };
          if (!overlaps(bounds) || p.fontPx <= P.OVERLAP_MIN_FONT_PX) break;
          p.fontPx = Math.max(P.OVERLAP_MIN_FONT_PX, p.fontPx * P.OVERLAP_SHRINK_FACTOR);
        }
      } else {
        bounds = { l: p.x - p.dotR - 2, t: p.y - p.dotR - 2, r: p.x + p.dotR + 2, b: p.y + p.dotR + 2 };
      }
      placedRects.push(bounds!);

      const rgb = p.question ? COLOR_ACCENT : COLOR_FG;
      const alpha = p.selected ? 1 : p.alpha;

      // 星(点)は常設
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

      if (p.textOnly) {
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const textX = p.x + p.dotR + 6;
        const lineH = p.fontPx * 1.4;
        let startY = p.y - ((p.lines.length - 1) * lineH) / 2;
        if (p.themeName && p.g.themeId) {
          const nameFont = Math.max(9, p.fontPx * 0.62);
          ctx.font = `${nameFont}px ${FONT_STACK}`;
          ctx.fillStyle = `rgba(${COLOR_THEME}, ${Math.min(1, alpha + 0.15)})`;
          const nameY = startY - lineH * 0.5 - nameFont * 0.6;
          ctx.fillText(p.themeName, textX, nameY);
          const w = ctx.measureText(p.themeName).width;
          themeRect = { x: textX, y: nameY - nameFont * 0.7, w, h: nameFont * 1.4, themeId: p.g.themeId };
        }
        ctx.font = `${p.fontPx}px ${FONT_STACK}`;
        ctx.fillStyle = `rgba(${rgb}, ${alpha})`;
        let ly = startY;
        for (const line of p.lines) {
          ctx.fillText(line, textX, ly);
          ly += lineH;
        }
      } else if (p.themeName && p.g.themeId) {
        // 全天でもテーマ名だけは微かに浮かぶ
        const nameFont = Math.max(9, 10 * this.zoom);
        ctx.font = `${nameFont}px ${FONT_STACK}`;
        ctx.fillStyle = `rgba(${COLOR_THEME}, 0.75)`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(p.themeName, p.x, p.y + p.dotR + 3);
        const w = ctx.measureText(p.themeName).width;
        themeRect = { x: p.x - w / 2, y: p.y + p.dotR + 3, w, h: nameFont * 1.3, themeId: p.g.themeId };
      }

      this.drawn.push({ g: p.g, dotX: p.x, dotY: p.y, bounds: bounds!, themeRect });
    }

    // ---- 星座の召喚: 選択した粒の幹・付箋だけ線で結ぶ(線は常設しない) ----
    if (selection.length === 1) {
      const sel = this.drawn.find((d) => d.g.id === selection[0] && !d.phantom);
      if (sel) this.drawConstellation(sel, state, cx, cy);
    }
  }

  // 選択粒の幹(親)と付箋を線で結ぶ。軌道上にいない縁者は幻影の星として召喚する
  private drawConstellation(sel: DrawnItem, state: State, cx: number, cy: number): void {
    const ctx = this.ctx;
    const g = sel.g;
    const parents = g.parentIds.map((id) => state.grains.find((x) => x.id === id)).filter((x): x is Grain => !!x);
    const stickers = state.grains.filter((s) => s.attachedToId === g.id);
    const relatives = [
      ...parents.map((p) => ({ grain: p, kind: '幹' as const })),
      ...stickers.map((s) => ({ grain: s, kind: '付箋' as const })),
    ];
    if (relatives.length === 0) return;

    // 幻影の配置: 惑星と反対側(外向き)に扇形に開く
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
        // 幻影の星
        const m = phantoms.length;
        const spread = m > 1 ? -0.55 + (1.1 * phantomIndex) / (m - 1) : 0;
        const dist = 64 * Math.max(0.7, Math.min(this.zoom, 1.5)) + phantomIndex * 6;
        tx = sel.dotX + Math.cos(baseAngle + spread) * dist;
        ty = sel.dotY + Math.sin(baseAngle + spread) * dist;
        phantomIndex++;
      }

      const dead = rel.grain.status !== 'alive';
      const question = isOpenQuestion(rel.grain);
      const rgb = question ? COLOR_ACCENT : COLOR_FG;

      // 線(線上に種別を小さく)
      ctx.beginPath();
      ctx.moveTo(sel.dotX, sel.dotY);
      ctx.lineTo(tx, ty);
      ctx.strokeStyle = `rgba(${COLOR_FG}, ${dead ? 0.12 : 0.22})`;
      ctx.lineWidth = 1;
      ctx.stroke();
      const midX = (sel.dotX + tx) / 2;
      const midY = (sel.dotY + ty) / 2;
      ctx.font = `9px ${FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = `rgba(${COLOR_FG}, 0.3)`;
      ctx.fillText(rel.kind, midX, midY - 2);

      if (!target) {
        // 幻影の星とラベル(死者は薄く、状態を添える)
        ctx.beginPath();
        ctx.arc(tx, ty, 2.2, 0, 2 * Math.PI);
        ctx.fillStyle = `rgba(${rgb}, ${dead ? 0.3 : 0.6})`;
        ctx.fill();

        const label =
          clipText(rel.grain.text, 18) +
          (rel.grain.status === 'drifted' ? ' ・漂流' : rel.grain.status === 'closed' ? ' ・閉幕' : '');
        ctx.font = `10px ${FONT_STACK}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = `rgba(${rgb}, ${dead ? 0.3 : 0.55})`;
        ctx.fillText(label, tx, ty + 5);
        const w = ctx.measureText(label).width;

        this.drawn.push({
          g: rel.grain,
          dotX: tx,
          dotY: ty,
          bounds: { l: tx - Math.max(w / 2, 8), t: ty - 8, r: tx + Math.max(w / 2, 8), b: ty + 18 },
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
        // 惑星に落とせば突入(閉幕)。それ以外は軌道に戻る
        const cx = this.canvas.clientWidth / 2;
        const cy = this.canvas.clientHeight / 2;
        const short = Math.min(this.canvas.clientWidth, this.canvas.clientHeight);
        const planetR = this.planetRadius(short, this.hooks.getState());
        if (Math.hypot(e.offsetX - cx, e.offsetY - cy) <= planetR * 1.4) {
          this.hooks.closeGrain(grainId);
        }
        return;
      }
      if (moved) return; // ダイヤル回転。クリックではない

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
        // 幻影(召喚された縁者)は生きていれば選択が移る。死者は表示のみ
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
    const cx = this.canvas.clientWidth / 2;
    const cy = this.canvas.clientHeight / 2;
    return Math.atan2(e.offsetY - cy, e.offsetX - cx);
  }

  private hitTest(
    x: number,
    y: number,
  ): { grainId?: string; themeId?: string; phantom?: boolean; alive?: boolean } | null {
    const PAD = 5;
    // 幻影(後から積まれた側)を優先して手前から探す
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
