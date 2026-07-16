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
export function touch(g: Grain, eco: number): void {
  g.lastTouchEco = eco;
}

// 「今」の面に表示される粒:
// 無所属の生きた粒すべて + 各テーマの代表粒（最も熱い生きた粒）ひとつ。
export function displayedGrains(state: State, eco: number): Grain[] {
  void eco;
  const out: Grain[] = [];
  const reps = new Map<string, Grain>();
  for (const g of state.grains) {
    if (g.status !== 'alive') continue;
    if (!g.themeId) {
      out.push(g);
      continue;
    }
    const cur = reps.get(g.themeId);
    if (!cur || g.lastTouchEco > cur.lastTouchEco) reps.set(g.themeId, g);
  }
  return out.concat([...reps.values()]);
}

// 沈降。警告なし・無音。変更があれば true。
export function cull(state: State, eco: number): boolean {
  let changed = false;

  // 1) 時間による沈降: 実効年齢が閾値を超えた生きた粒は漂流する
  for (const g of state.grains) {
    if (g.status === 'alive' && effectiveAge(g, eco) > P.SINK_AGE_SECONDS) {
      g.status = 'drifted';
      changed = true;
    }
  }

  // 2) 帯域規制: 表示総数が上限を超えたら、最も冷えた粒から漂流する
  let disp = displayedGrains(state, eco);
  if (disp.length > P.BAND_LIMIT) {
    const coldestFirst = [...disp].sort((a, b) => effectiveAge(b, eco) - effectiveAge(a, eco));
    for (const g of coldestFirst) {
      if (disp.length <= P.BAND_LIMIT) break;
      g.status = 'drifted';
      changed = true;
      disp = displayedGrains(state, eco);
    }
  }

  return changed;
}

export function tierOf(effAge: number): { fontSizePx: number; opacity: number } {
  for (const t of P.DISPLAY_TIERS) {
    if (effAge <= t.upToSeconds) return t;
  }
  return P.DISPLAY_TIERS[P.DISPLAY_TIERS.length - 1];
}
