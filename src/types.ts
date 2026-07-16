export type GrainStatus = 'alive' | 'drifted' | 'closed';

export interface Grain {
  id: string;
  text: string;
  createdAtWall: number;      // 壁時計の作成時刻（表示用、epoch ms）
  lastTouchEco: number;       // 生態系時刻（秒）での最終接触
  status: GrainStatus;
  closedAtWall?: number;      // 閉幕した時刻。惑星内の堆積順(考古学)に使う
  closedNote?: string;        // 閉幕時の一言（任意）= 墓碑銘
  revivedNote?: string;       // 蘇生時の一言（蘇生には必須）
  parentIds: string[];        // 幹（系譜）。作成時に決まり不変
  linkIds?: string[];         // 細い幹。ドラッグで後から張る弱い参照
  attachedToId?: string | null; // 付箋の場合、貼り付き先の粒
  themeId?: string | null;    // 析出済みならテーマID
  cometReturnAtWall?: number | null;     // 彗星: 次の帰還時刻(壁時計)。非nullの間は軌道上=視界外・凍結
  cometPeriodDays?: number | null;       // 周期彗星: 公転周期(日)。冷え切ると漂流の代わりに再出発する
  cometLastReturnAtWall?: number | null; // 直近の帰還時刻。次の帰還の基準(周期の錨)
  cometTail?: boolean;                   // 帰還後まだ触られていない印。触ると尾が消える(捕獲)
  angle?: number;             // 空での固有の角度(ラジアン)。誕生時に決まり、ドラッグでのみ動く
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
