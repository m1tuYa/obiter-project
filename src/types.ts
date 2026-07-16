export type GrainStatus = 'alive' | 'drifted' | 'closed';

export interface Grain {
  id: string;
  text: string;
  createdAtWall: number;      // 壁時計の作成時刻（表示用、epoch ms）
  lastTouchEco: number;       // 生態系時刻（秒）での最終接触
  status: GrainStatus;
  closedNote?: string;        // 閉幕時の一言（任意）
  revivedNote?: string;       // 蘇生時の一言（蘇生には必須）
  parentIds: string[];        // 幹（系譜）。不変
  attachedToId?: string | null; // 付箋の場合、貼り付き先の粒
  themeId?: string | null;    // 析出済みならテーマID
  cometReturnAtWall?: number | null; // 彗星: 帰還予定日（第一段では未使用）
}

export interface Theme {
  id: string;
  name: string;
  createdAtWall: number;
}

export interface State {
  grains: Grain[];
  themes: Theme[];
  ecoSeconds: number; // 累積の生態系時刻（秒）
}
