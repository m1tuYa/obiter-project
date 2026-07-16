import { PARAMS as P } from './params';
import type { Grain, State } from './types';
import { displayedGrains, effectiveAge, isOpenQuestion, tierOf } from './ecosystem';

// 「今」の面のCanvas描画。周回・ズーム・回転・参照系の乗り移りを担う。
// 力学だけを借り、見た目は抽象に保つ。

export interface SkyHooks {
  getState(): State;
  getEco(): number;
  getSelection(): string[];
  setSelection(ids: string[]): void;
  openTheme(themeId: string): void;
  correct(grainId: string): void;
  isActive(): boolean; // 「今」の面が表示中か
}

interface DrawnItem {
  g: Grain;
  x: number;
  y: number;
  w: number;
  h: number;
  themeRect?: { x: number; y: number; w: number; h: number; themeId: string };
}

const COLOR_FG = '216, 222, 233';
const COLOR_ACCENT = '229, 192, 123';
const COLOR_THEME = '138, 180, 216';

export class Sky {
  private ctx: CanvasRenderingContext2D;
  private zoom = 1;
  private manualRot = 0; // ダイヤル(手動回転)
  private animT = 0; // 演出用の時計。フォーカス中だけ進む(不在中は空も凍結)
  private lastFrame = 0;
  private drawn: DrawnItem[] = [];

  // 参照系: 乗っている粒。静止して見え、残りが流れる
  private refId: string | null = null;
  private refFrozenAngle = 0;

  // ドラッグ回転
  private dragging = false;
  private dragMoved = false;
  private downAngle = 0;
  private downRot = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private hooks: SkyHooks,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.bindEvents();
    requestAnimationFrame(this.frame);
  }

  // 選択が変わったら参照系も乗り替える(先頭の粒に乗る)
  onSelectionChanged(ids: string[]): void {
    if (ids.length === 0) {
      this.refId = null;
      return;
    }
    const id = ids[0];
    if (this.refId === id) return;
    const angles = this.computeAngles();
    const a = angles.get(id);
    if (a !== undefined) {
      this.refId = id;
      this.refFrozenAngle = a;
    } else {
      this.refId = null;
    }
  }

  // 直近フレームで描いた粒の画面座標(構造パネルの位置決め用)
  project(grainId: string): { x: number; y: number; h: number } | null {
    const item = this.drawn.find((d) => d.g.id === grainId);
    return item ? { x: item.x, y: item.y, h: item.h } : null;
  }

  // ---------- 力学 ----------

  private orbitOmega(frac: number): number {
    // 熱い(frac=0)ほど速く、冷えた(frac=1)ほど遅い
    const period = P.ORBIT_PERIOD_HOT_SECONDS;
    const factor = 1 - frac * (1 - P.ORBIT_COLD_FACTOR);
    return ((2 * Math.PI) / period) * factor;
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

    // ---- 惑星(閉幕の堆積。静かに育ち、祝われない) ----
    const closedCount = state.grains.filter((g) => g.status === 'closed').length;
    const planetR = (Math.min(short * 0.1, 22 + Math.sqrt(closedCount) * 4) * this.zoom) / 1;
    const grad = ctx.createRadialGradient(cx - planetR * 0.3, cy - planetR * 0.35, planetR * 0.1, cx, cy, planetR);
    grad.addColorStop(0, '#3a4258');
    grad.addColorStop(0.45, '#2a3040');
    grad.addColorStop(0.8, '#1a1f2c');
    grad.addColorStop(1, '#12161f');
    ctx.beginPath();
    ctx.arc(cx, cy, planetR, 0, 2 * Math.PI);
    ctx.fillStyle = grad;
    ctx.fill();
    // 淡い光暈
    ctx.beginPath();
    ctx.arc(cx, cy, planetR * 1.35, 0, 2 * Math.PI);
    const halo = ctx.createRadialGradient(cx, cy, planetR, cx, cy, planetR * 1.35);
    halo.addColorStop(0, 'rgba(100,120,170,0.08)');
    halo.addColorStop(1, 'rgba(100,120,170,0)');
    ctx.fillStyle = halo;
    ctx.fill();

    // ---- 粒 ----
    const grains = displayedGrains(state, eco).sort((a, b) => b.lastTouchEco - a.lastTouchEco);
    const n = Math.max(grains.length, 1);
    const rMin = Math.max(short * P.RADIUS_MIN_RATIO * this.zoom, planetR + 34);
    const rMax = short * P.RADIUS_MAX_RATIO * this.zoom;

    // 参照系のオフセット: 乗っている粒が動いた分だけ全体を巻き戻す
    let refOffset = 0;
    if (this.refId) {
      const angles = this.computeAngles();
      const a = angles.get(this.refId);
      if (a !== undefined) refOffset = a - this.refFrozenAngle;
      else this.refId = null; // 乗っていた粒が去った
    }

    interface Pending {
      g: Grain;
      x: number;
      y: number;
      fontPx: number;
      alpha: number;
      lines: string[];
      isDot: boolean;
      themeName?: string;
      selected: boolean;
      question: boolean;
      frac: number;
    }
    const pendings: Pending[] = [];

    grains.forEach((g, i) => {
      const effAge = effectiveAge(g, eco);
      const frac = Math.min(1, effAge / P.SINK_AGE_SECONDS);
      const tier = tierOf(effAge);
      const base = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      const angle = base + this.animT * this.orbitOmega(frac) - refOffset + this.manualRot;
      const r = rMin + Math.pow(frac, 0.6) * (rMax - rMin);
      const x = cx + r * Math.cos(angle);
      const y = cy + r * Math.sin(angle);

      const fontPx = tier.fontSizePx * Math.pow(this.zoom, 0.9);
      // 縮退: ズーム×温度で見える文字量が決まる(数語→一行→全文)
      const budget = Math.round((14 + 60 * (1 - frac)) * this.zoom);
      const isDot = fontPx < 7 || budget < 4;

      const theme = g.themeId ? state.themes.find((t) => t.id === g.themeId) : undefined;
      const selected = selection.includes(g.id);
      pendings.push({
        g,
        x,
        y,
        fontPx,
        alpha: tier.opacity,
        lines: [],
        isDot,
        themeName: theme?.name,
        selected,
        question: isOpenQuestion(g),
        frac,
      });
    });

    // 熱い順に配置し、重なったら冷たい側のフォントを縮める(重なり禁止)
    this.drawn = [];
    const placedRects: { x: number; y: number; w: number; h: number }[] = [];
    const GAP = 4;
    const overlaps = (a: { x: number; y: number; w: number; h: number }) =>
      placedRects.some(
        (b) =>
          a.x - a.w / 2 < b.x + b.w / 2 + GAP &&
          b.x - b.w / 2 < a.x + a.w / 2 + GAP &&
          a.y - a.h / 2 < b.y + b.h / 2 + GAP &&
          b.y - b.h / 2 < a.y + a.h / 2 + GAP,
      );

    for (const p of pendings) {
      let rect: { x: number; y: number; w: number; h: number };
      if (p.isDot) {
        const dotR = 2.5 * Math.sqrt(Math.max(this.zoom, 0.4));
        rect = { x: p.x, y: p.y, w: dotR * 2, h: dotR * 2 };
      } else {
        const budget = Math.round((14 + 60 * (1 - p.frac)) * this.zoom);
        const text = p.g.text.length > budget ? p.g.text.slice(0, budget) + '…' : p.g.text;
        while (true) {
          ctx.font = `${p.fontPx}px "Hiragino Sans", "Yu Gothic UI", sans-serif`;
          const maxLineW = Math.min(420, Math.max(140, 300 * this.zoom));
          p.lines = wrapText(ctx, text, maxLineW, 3);
          const w = Math.max(...p.lines.map((l) => ctx.measureText(l).width), 1);
          const h = p.lines.length * p.fontPx * 1.4 + (p.themeName ? p.fontPx * 0.9 : 0);
          rect = { x: p.x, y: p.y, w, h };
          if (!overlaps(rect) || p.fontPx <= P.OVERLAP_MIN_FONT_PX) break;
          p.fontPx = Math.max(P.OVERLAP_MIN_FONT_PX, p.fontPx * P.OVERLAP_SHRINK_FACTOR);
        }
      }
      placedRects.push(rect);

      // ---- 実描画 ----
      const rgb = p.question ? COLOR_ACCENT : COLOR_FG;
      const alpha = p.selected ? 1 : p.alpha;
      if (p.selected) {
        ctx.shadowColor = `rgba(${rgb}, 0.85)`;
        ctx.shadowBlur = 14;
      }

      let themeRect: DrawnItem['themeRect'];
      if (p.isDot) {
        const dotR = 2.5 * Math.sqrt(Math.max(this.zoom, 0.4));
        ctx.beginPath();
        ctx.arc(p.x, p.y, dotR, 0, 2 * Math.PI);
        ctx.fillStyle = `rgba(${rgb}, ${Math.max(alpha, 0.45)})`;
        ctx.fill();
        // 全天でもテーマ名だけは微かに浮かぶ
        if (p.themeName && p.g.themeId) {
          const nameFont = Math.max(9, 10 * this.zoom);
          ctx.font = `${nameFont}px "Hiragino Sans", "Yu Gothic UI", sans-serif`;
          ctx.fillStyle = `rgba(${COLOR_THEME}, 0.75)`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillText(p.themeName, p.x, p.y + dotR + 3);
          const w = ctx.measureText(p.themeName).width;
          themeRect = { x: p.x - w / 2, y: p.y + dotR + 3, w, h: nameFont * 1.3, themeId: p.g.themeId };
        }
      } else {
        ctx.font = `${p.fontPx}px "Hiragino Sans", "Yu Gothic UI", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const lineH = p.fontPx * 1.4;
        let startY = p.y - ((p.lines.length - 1) * lineH) / 2;
        if (p.themeName && p.g.themeId) {
          const nameFont = Math.max(9, p.fontPx * 0.62);
          ctx.font = `${nameFont}px "Hiragino Sans", "Yu Gothic UI", sans-serif`;
          ctx.fillStyle = `rgba(${COLOR_THEME}, ${Math.min(1, alpha + 0.15)})`;
          const nameY = startY - lineH * 0.55 - nameFont * 0.7;
          ctx.fillText(p.themeName, p.x, nameY);
          const w = ctx.measureText(p.themeName).width;
          themeRect = { x: p.x - w / 2, y: nameY - nameFont / 2, w, h: nameFont * 1.4, themeId: p.g.themeId };
          ctx.font = `${p.fontPx}px "Hiragino Sans", "Yu Gothic UI", sans-serif`;
        }
        ctx.fillStyle = `rgba(${rgb}, ${alpha})`;
        for (const line of p.lines) {
          ctx.fillText(line, p.x, startY);
          startY += lineH;
        }
      }
      ctx.shadowBlur = 0;

      const last = placedRects[placedRects.length - 1];
      this.drawn.push({ g: p.g, x: p.x, y: p.y, w: last.w, h: last.h, themeRect });
    }
  }

  // ---------- 入力 ----------

  private bindEvents(): void {
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const next = this.zoom * Math.exp(-e.deltaY * 0.0012);
      this.zoom = Math.min(P.ZOOM_MAX, Math.max(P.ZOOM_MIN, next));
    }, { passive: false });

    this.canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.dragMoved = false;
      this.downAngle = this.pointerAngle(e);
      this.downRot = this.manualRot;
      this.canvas.setPointerCapture(e.pointerId);
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const a = this.pointerAngle(e);
      let delta = a - this.downAngle;
      if (Math.abs(delta) > 0.012) this.dragMoved = true;
      if (this.dragMoved) this.manualRot = this.downRot + delta;
    });

    this.canvas.addEventListener('pointerup', (e) => {
      this.dragging = false;
      if (this.dragMoved) return; // 回転操作。クリックではない
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
      const id = hit.grainId!;
      // 選択は接触に数えない(代謝ゼロ)
      if (e.ctrlKey || e.metaKey) {
        this.hooks.setSelection(
          selection.includes(id) ? selection.filter((s) => s !== id) : [...selection, id],
        );
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

  private hitTest(x: number, y: number): { grainId?: string; themeId?: string } | null {
    // 手前(熱い側=先に描いた側)を優先したいので前から探す
    const PAD = 6;
    for (const d of this.drawn) {
      if (d.themeRect) {
        const t = d.themeRect;
        if (x >= t.x - PAD && x <= t.x + t.w + PAD && y >= t.y - PAD && y <= t.y + t.h + PAD) {
          return { themeId: t.themeId };
        }
      }
      if (
        x >= d.x - d.w / 2 - PAD &&
        x <= d.x + d.w / 2 + PAD &&
        y >= d.y - d.h / 2 - PAD &&
        y <= d.y + d.h / 2 + PAD
      ) {
        return { grainId: d.g.id };
      }
    }
    return null;
  }
}

// 文字列をmaxWidthで折り返す(日本語は文字単位)。maxLinesを超えたら…で切る
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
