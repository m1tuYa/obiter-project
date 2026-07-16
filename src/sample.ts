import type { State } from './types';

// サンプルデータ: 生態系が回っている途中の状態を再現する。
// 生態系時刻 12600秒(滞在3.5時間)の時点。熱い粒から沈降間際・漂流・閉幕まで一通り。
export function buildSampleState(): State {
  const E = 12600; // 現在の生態系時刻
  const now = Date.now();
  const h = 3600 * 1000;
  const d = 24 * h;

  return {
    ecoSeconds: E,
    themes: [
      { id: 'smp-theme-1', name: '注意の生態系', createdAtWall: now - 3 * d },
    ],
    grains: [
      // ---- 無所属の生きた粒(温度いろいろ) ----
      {
        id: 'smp-g1',
        text: 'orbiterの検証開始。まずは自分の思考をそのまま流し込んでみる',
        createdAtWall: now - 30 * 60 * 1000,
        lastTouchEco: E - 300,
        status: 'alive', parentIds: [], attachedToId: null, themeId: null, cometReturnAtWall: null,
      },
      {
        id: 'smp-g2',
        text: '?沈降の3時間は長すぎるか、使いながら見る',
        createdAtWall: now - 5 * h,
        lastTouchEco: E - 900,
        status: 'alive', parentIds: [], attachedToId: null, themeId: null, cometReturnAtWall: null,
      },
      {
        id: 'smp-g3',
        text: '帯域30は多いかもしれない。20でも回る気がする',
        createdAtWall: now - 8 * h,
        lastTouchEco: E - 2400,
        status: 'alive', parentIds: [], attachedToId: null, themeId: null, cometReturnAtWall: null,
      },
      {
        id: 'smp-g4',
        text: '読んだ本の断片: 注意は資源ではなく器官だという比喩',
        createdAtWall: now - 2 * d,
        lastTouchEco: E - 1200, // 合流に触られて温まった
        status: 'alive', parentIds: [], attachedToId: null, themeId: null, cometReturnAtWall: null,
      },
      {
        id: 'smp-g8',
        text: 'メモが増えるほど探せなくなる矛盾について',
        createdAtWall: now - 2 * d,
        lastTouchEco: E - 1200, // 合流に触られて温まった
        status: 'alive', parentIds: [], attachedToId: null, themeId: null, cometReturnAtWall: null,
      },
      {
        // 合流の粒: 複数の幹を持つ
        id: 'smp-g7',
        text: '器官の比喩と検索の矛盾は同じことを言っている——外部化した注意には置き場が要る',
        createdAtWall: now - 6 * h,
        lastTouchEco: E - 1200,
        status: 'alive', parentIds: ['smp-g4', 'smp-g8'], attachedToId: null, themeId: null, cometReturnAtWall: null,
      },
      {
        id: 'smp-g5',
        text: '散歩中に考えたこと: ツールが思考を変えるのではなく、思考の置き場が変わる',
        createdAtWall: now - 1 * d,
        lastTouchEco: E - 8200, // だいぶ冷えている
        status: 'alive', parentIds: [], attachedToId: null, themeId: null, cometReturnAtWall: null,
      },
      {
        id: 'smp-g6',
        text: '会議メモは別の場所でいい。ここは思考だけ',
        createdAtWall: now - 36 * h,
        lastTouchEco: E - 9800, // 沈降間際
        status: 'alive', parentIds: [], attachedToId: null, themeId: null, cometReturnAtWall: null,
      },
      {
        // 蘇生済みの粒(開いた疑問でもある)
        id: 'smp-g11',
        text: '?思考の速度と書く速度の差をどう埋めるか',
        createdAtWall: now - 2 * d,
        lastTouchEco: E - 1000,
        status: 'alive', revivedNote: 'やっぱりこの問いは生きている',
        parentIds: [], attachedToId: null, themeId: null, cometReturnAtWall: null,
      },

      // ---- テーマ「注意の生態系」の尾 ----
      {
        id: 'smp-t1',
        text: '思考メモが墓場になるのは、忘れることを許さない設計のせいではないか',
        createdAtWall: now - 3 * d,
        lastTouchEco: 400, // とうに漂流。でも尾では読める
        status: 'drifted', parentIds: [], attachedToId: null, themeId: 'smp-theme-1', cometReturnAtWall: null,
      },
      {
        id: 'smp-t2',
        text: '忘れる速度を設計する、という言い方の方が正しい。何を残すかではなく何を手放すか',
        createdAtWall: now - 60 * h,
        lastTouchEco: 8000,
        status: 'alive', parentIds: ['smp-t1'], attachedToId: null, themeId: 'smp-theme-1', cometReturnAtWall: null,
      },
      {
        id: 'smp-t3',
        text: '手放しのデフォルト化。生かす方に印を要求する非対称が肝',
        createdAtWall: now - 1 * d,
        lastTouchEco: E - 400, // 付箋に触られて先端が熱い
        status: 'alive', parentIds: ['smp-t2'], attachedToId: null, themeId: 'smp-theme-1', cometReturnAtWall: null,
      },
      {
        // 先端に貼られた開いた疑問付箋
        id: 'smp-s1',
        text: '?圧縮(まとめなおし)の単位は何にする',
        createdAtWall: now - 2 * h,
        lastTouchEco: E - 400,
        status: 'alive', parentIds: ['smp-t3'], attachedToId: 'smp-t3', themeId: 'smp-theme-1', cometReturnAtWall: null,
      },

      // ---- 死者(検索で見つかる。閉幕組は惑星の断面に眠る) ----
      {
        id: 'smp-g9',
        text: 'ダークモードの配色はあとで調整する',
        createdAtWall: now - 2 * d,
        lastTouchEco: 3000,
        status: 'closed', closedAtWall: now - 20 * h, closedNote: '試しに閉じてみた。閉幕は軽い',
        parentIds: [], attachedToId: null, themeId: null, cometReturnAtWall: null,
      },
      {
        id: 'smp-g12',
        text: '週次レビューの仕組みを考える',
        createdAtWall: now - 3 * d,
        lastTouchEco: 2000,
        status: 'closed', closedAtWall: now - 2 * d, closedNote: '仕組みではなく習慣の問題だった',
        parentIds: [], attachedToId: null, themeId: null, cometReturnAtWall: null,
      },
      {
        id: 'smp-g13',
        text: '?メモは何のために取るのか',
        createdAtWall: now - 3 * d,
        lastTouchEco: 2500,
        status: 'closed', closedAtWall: now - 40 * h, closedNote: '答えは「思い出すため」ではなかった',
        parentIds: [], attachedToId: null, themeId: null, cometReturnAtWall: null,
      },
      {
        id: 'smp-g14',
        text: '読書リストの整理',
        createdAtWall: now - 60 * h,
        lastTouchEco: 2800,
        status: 'closed', closedAtWall: now - 30 * h,
        parentIds: [], attachedToId: null, themeId: null, cometReturnAtWall: null,
      },
      {
        id: 'smp-g10',
        text: '昔考えていたZettelkastenへの移行計画。リンクを張る作業が続かなかった',
        createdAtWall: now - 3 * d,
        lastTouchEco: 100,
        status: 'drifted', parentIds: [], attachedToId: null, themeId: null, cometReturnAtWall: null,
      },
    ],
  };
}
