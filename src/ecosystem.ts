import { PARAMS as P } from './params';
import type { Grain, State } from './types';

// 「?」「？」で始まる未閉幕の粒は開いた疑問。
// 本人確認済みの判断: 種類による優遇を許可し、冷え方そのものを遅くする（死の一法則の明示的例外）。
export function isOpenQuestion(g: Grain): boolean {
  if (g.status !== 'alive') return false;
  const t = g.text.trimStart();
  return t.startsWith('?') || t.startsWith('？');
}

// 実効年齢: 最終接触からの生態系秒。開いた疑問は倍率ぶんゆっくり老いる。
export function effectiveAge(g: Grain, eco: number): number {
  const age = Math.max(0, eco - g.lastTouchEco);
  return isOpenQuestion(g) ? age / P.QUESTION_SINK_MULTIPLIER : age;
}

// 時計の巻き戻し。呼んでよいのは: 付箋の追加 / 子の追加 / 蘇生 のみ。
// 帰還中の彗星に触れたら捕獲(尾が消える)
export function touch(g: Grain, eco: number): void {
  g.lastTouchEco = eco;
  if (g.cometTail) g.cometTail = false;
}

// 軌道上(視界外)の彗星か
export function isAwayComet(g: Grain): boolean {
  return g.cometReturnAtWall != null;
}

// 「今」の面に表示される粒:
// 無所属の生きた粒すべて + 各テーマの代表粒（最も熱い生きた粒）ひとつ。
export function displayedGrains(state: State, eco: number): Grain[] {
  void eco;
  const out: Grain[] = [];
  // 代表粒は付箋でない粒を優先する(付箋しか生きていないテーマだけ付箋が代表になる)
  const repsMain = new Map<string, Grain>();
  const repsAny = new Map<string, Grain>();
  for (const g of state.grains) {
    if (g.status !== 'alive') continue;
    if (isAwayComet(g)) continue; // 軌道上の彗星は視界にいない(帯域も消費しない)
    if (!g.themeId) {
      out.push(g);
      continue;
    }
    const anyCur = repsAny.get(g.themeId);
    if (!anyCur || g.lastTouchEco > anyCur.lastTouchEco) repsAny.set(g.themeId, g);
    if (!g.attachedToId) {
      const mainCur = repsMain.get(g.themeId);
      if (!mainCur || g.lastTouchEco > mainCur.lastTouchEco) repsMain.set(g.themeId, g);
    }
  }
  for (const [themeId, g] of repsAny) {
    out.push(repsMain.get(themeId) ?? g);
  }
  return out;
}

// 沈降。警告なし・無音。変更があれば true。
// 周期彗星は冷え切ったとき、漂流する代わりに次の軌道へ再出発する(「無視すればまた遠ざかる」)
export function cull(state: State, eco: number, wallNow: number): boolean {
  let changed = false;

  const sink = (g: Grain): void => {
    if (g.cometPeriodDays) {
      const period = g.cometPeriodDays * 86400000;
      let next = (g.cometLastReturnAtWall ?? wallNow) + period;
      while (next <= wallNow) next += period;
      g.cometReturnAtWall = next;
      g.cometTail = false;
    } else {
      g.status = 'drifted';
    }
    changed = true;
  };

  // 1) 時間による沈降: 実効年齢が閾値を超えた生きた粒は漂流する(軌道上の彗星は凍結)
  for (const g of state.grains) {
    if (g.status === 'alive' && !isAwayComet(g) && effectiveAge(g, eco) > P.SINK_AGE_SECONDS) {
      sink(g);
    }
  }

  // 2) 帯域規制: 表示総数が上限を超えたら、最も冷えた粒から漂流する
  let disp = displayedGrains(state, eco);
  if (disp.length > P.BAND_LIMIT) {
    const coldestFirst = [...disp].sort((a, b) => effectiveAge(b, eco) - effectiveAge(a, eco));
    for (const g of coldestFirst) {
      if (disp.length <= P.BAND_LIMIT) break;
      sink(g);
      disp = displayedGrains(state, eco);
    }
  }

  return changed;
}

// 角度を持たない粒(旧データ・インポート)に固有の角度を与える。
// 親がいる粒は親のそば、無所属はidのハッシュでばらまく。以後この角度は動かさない
export function ensureAngles(state: State): void {
  const byId = new Map(state.grains.map((g) => [g.id, g]));
  const resolving = new Set<string>();

  const resolve = (g: Grain): number => {
    if (typeof g.angle === 'number') return g.angle;
    if (resolving.has(g.id)) {
      g.angle = hashAngle(g.id);
      return g.angle;
    }
    resolving.add(g.id);
    const parentId = g.attachedToId ?? g.parentIds[0];
    const parent = parentId ? byId.get(parentId) : undefined;
    g.angle = parent ? resolve(parent) + hashJitter(g.id) : hashAngle(g.id);
    resolving.delete(g.id);
    return g.angle;
  };

  for (const g of state.grains) resolve(g);
}

function hashOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

export function hashAngle(id: string): number {
  return ((hashOf(id) % 3600) / 3600) * 2 * Math.PI;
}

export function hashJitter(id: string): number {
  return ((((hashOf(id) >>> 8) % 100) - 50) / 100) * 0.6;
}

// 残響: 意味的関連は保存せず、求められたときだけ計算する(概念文書の明文規定)。
// 文字2-gramのDice係数による単純な字面の類似。AIは使わない
export function similarity(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return (2 * inter) / (A.size + B.size);
}

function bigrams(s: string): Set<string> {
  const t = s.replace(/[\s、。?？!！]/g, '');
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

export function tierOf(effAge: number): { fontSizePx: number; opacity: number } {
  for (const t of P.DISPLAY_TIERS) {
    if (effAge <= t.upToSeconds) return t;
  }
  return P.DISPLAY_TIERS[P.DISPLAY_TIERS.length - 1];
}
