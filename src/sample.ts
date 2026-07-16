import type { Grain, GrainStatus, State } from './types';

// サンプルデータ: 2週間ほど使い込んだ状態を再現する。
// 生態系時刻 80000秒(滞在約22時間)。生きた粒約30、テーマ3本、
// リンクの星座、漂流約10、閉幕約30(惑星の断面が埋まる)。
export function buildSampleState(): State {
  const E = 80000;
  const now = Date.now();
  const h = 3600 * 1000;

  const grains: Grain[] = [];
  let seq = 0;

  const add = (o: {
    text: string;
    ageEco?: number; // 最終接触からの生態系秒
    wallAgeH?: number; // 作成からの実時間(時間)
    status?: GrainStatus;
    parents?: string[];
    attachedTo?: string;
    themeId?: string;
    links?: string[];
    angle?: number;
    closedAgoH?: number;
    closedNote?: string;
    revivedNote?: string;
    cometInH?: number; // 彗星: 何時間後に帰還するか
    periodDays?: number; // 周期彗星
  }): string => {
    const id = `smp-${++seq}`;
    grains.push({
      id,
      text: o.text,
      createdAtWall: now - (o.wallAgeH ?? 24) * h,
      lastTouchEco: E - (o.ageEco ?? 3000),
      status: o.status ?? 'alive',
      parentIds: o.parents ?? [],
      linkIds: o.links,
      attachedToId: o.attachedTo ?? null,
      themeId: o.themeId ?? null,
      cometReturnAtWall: o.cometInH !== undefined ? now + o.cometInH * h : null,
      cometPeriodDays: o.periodDays ?? null,
      angle: o.angle,
      closedAtWall: o.closedAgoH !== undefined ? now - o.closedAgoH * h : undefined,
      closedNote: o.closedNote,
      revivedNote: o.revivedNote,
    });
    return id;
  };

  // ---------- 無所属の生きた粒(熱いものから沈降間際まで) ----------
  add({ text: '朝の散歩で考えた: 集中は増やすものではなく守るもの', ageEco: 300, wallAgeH: 1 });
  add({ text: '?生態系の帯域30は自分には多い。20に絞ると何が変わる', ageEco: 700, wallAgeH: 3 });
  add({ text: '税金の書類、控除証明を探すところから', ageEco: 1200, wallAgeH: 5 });
  const gTalk = add({ text: '昨日の会話メモ: 人は道具の形に思考を合わせてしまう', ageEco: 1500, wallAgeH: 26 });
  add({ text: 'アイデア: 週の終わりに惑星を眺める儀式', ageEco: 2600, wallAgeH: 8 });
  add({ text: 'Tさんに借りた本を返す', ageEco: 3400, wallAgeH: 30 });
  const gSpeed = add({ text: '文章の速度についての違和感、まだ言葉にならない', ageEco: 1500, wallAgeH: 50 });
  add({ text: '実験: 疑問符で始めた粒だけ長生きするか観察する', ageEco: 5200, wallAgeH: 12 });
  add({ text: '買い物: コーヒー豆、電池', ageEco: 6200, wallAgeH: 14 });
  add({ text: '?思考の粒度はどこで決まるのか。一呼吸の長さ?', ageEco: 7300, wallAgeH: 60 });
  add({ text: '昔の日記を読み返して感じた距離。あれも他人の文章', ageEco: 8500, wallAgeH: 70 });
  add({ text: '机の配置換えの案、窓に背を向ける', ageEco: 9600, wallAgeH: 80 });

  // リンクで結ばれた星座(手で寄せたクラスタ)
  const cA = add({ text: '書くことは考えることの外部化ではなく、考えることそのもの', ageEco: 2000, wallAgeH: 40, angle: 2.1 });
  add({ text: '打鍵の速度と思考の速度が一致する瞬間がある', ageEco: 2900, wallAgeH: 36, links: [cA], angle: 2.28 });
  add({ text: '?口述だと思考の質は変わるか', ageEco: 3800, wallAgeH: 33, links: [cA], angle: 2.45 });

  // 合流の粒(二本の幹)
  add({
    text: '道具は透明になったときに完成する——編集器の理想と生態系の理想は同じだった',
    ageEco: 1500,
    wallAgeH: 20,
    parents: [gTalk, gSpeed],
  });

  // 蘇生済みの開いた疑問
  add({
    text: '?自分の言葉になっていない知識をどう見分けるか',
    ageEco: 1000,
    wallAgeH: 120,
    revivedNote: '三度目の転生。本物らしい',
  });

  add({ text: '次の休みに温泉、費用を調べる', ageEco: 450, wallAgeH: 2 });
  add({ text: '音楽を流すと書けない日と書ける日の差', ageEco: 2200, wallAgeH: 28 });
  add({ text: 'ノートの物理サイズが思考のサイズを決めていた説', ageEco: 3000, wallAgeH: 44 });
  add({ text: 'ランニング再開、まず靴', ageEco: 4700, wallAgeH: 48 });
  add({ text: '会議で言えなかった違和感: 目標が手段の言い換えになっている', ageEco: 5800, wallAgeH: 55 });
  add({ text: 'アプリの通知を全部切って三日目。静か', ageEco: 6800, wallAgeH: 72 });
  add({ text: '?退屈は思考の材料か、それとも欠乏か', ageEco: 7800, wallAgeH: 90 });
  add({ text: '棚の写真を整理する', ageEco: 8800, wallAgeH: 100 });
  add({ text: '言い切る文体への憧れと恐れ', ageEco: 9900, wallAgeH: 110 });

  // ---------- 彗星(軌道上。全天まで引くと外縁に見える) ----------
  add({ text: '金曜の自分へ: 原稿の第二稿に着手する', ageEco: 400, wallAgeH: 8, cometInH: 40 });
  add({ text: '週次の見返し。惑星を眺めて、ひとつだけ蘇生する', ageEco: 600, wallAgeH: 100, cometInH: 70, periodDays: 7 });

  // ---------- テーマ ----------
  const themes = [
    { id: 'smp-th-1', name: '注意の生態系', createdAtWall: now - 300 * h },
    { id: 'smp-th-2', name: 'orbiterの設計', createdAtWall: now - 200 * h },
    { id: 'smp-th-3', name: '読書: スマートノート', createdAtWall: now - 250 * h },
  ];

  // 注意の生態系
  const t1a = add({ text: '思考メモが墓場になるのは、忘れることを許さない設計のせい', ageEco: 70000, wallAgeH: 300, status: 'drifted', themeId: 'smp-th-1' });
  const t1b = add({ text: '忘れる速度を設計する。何を残すかではなく何を手放すか', ageEco: 50000, wallAgeH: 260, parents: [t1a], themeId: 'smp-th-1' });
  const t1c = add({ text: '手放しのデフォルト化。生かす方に印を要求する非対称が肝', ageEco: 9000, wallAgeH: 150, parents: [t1b], themeId: 'smp-th-1' });
  const t1d = add({ text: '帯域は倫理の問題。何に注意を払うかの宣言でもある', ageEco: 900, wallAgeH: 30, parents: [t1c], themeId: 'smp-th-1' });
  add({ text: '?圧縮(まとめなおし)の単位は何にする', ageEco: 700, wallAgeH: 10, parents: [t1d], attachedTo: t1d, themeId: 'smp-th-1' });
  add({ text: 'これは自分の言葉になった', ageEco: 8000, wallAgeH: 140, parents: [t1c], attachedTo: t1c, themeId: 'smp-th-1' });

  // orbiterの設計
  const t2a = add({ text: 'UIは常設の道具を持たない。すべて召喚される', ageEco: 60000, wallAgeH: 190, status: 'drifted', themeId: 'smp-th-2' });
  const t2b = add({ text: '線は選択時のみ。構造は召喚されるもの', ageEco: 7000, wallAgeH: 120, parents: [t2a], themeId: 'smp-th-2' });
  const t2c = add({ text: '地表視点はダイヤルで昨日を遡る場所になった', ageEco: 1100, wallAgeH: 6, parents: [t2b], themeId: 'smp-th-2' });
  add({ text: '?スマホの射出台はいつ作る', ageEco: 600, wallAgeH: 4, parents: [t2c], attachedTo: t2c, themeId: 'smp-th-2' });

  // 読書
  const t3a = add({ text: '引用ではなく自分の言葉で書き直せ、が全章の核', ageEco: 65000, wallAgeH: 250, status: 'drifted', themeId: 'smp-th-3' });
  const t3b = add({ text: '保存の場所ではなく、思考の相手としてのノート', ageEco: 8600, wallAgeH: 170, parents: [t3a], themeId: 'smp-th-3' });
  add({ text: 'レビューの仕組みは真似しない。生態系に淘汰させる', ageEco: 2400, wallAgeH: 40, parents: [t3b], themeId: 'smp-th-3' });

  // ---------- 漂流(未決のまま冷めた粒。検索で呼べる) ----------
  const drifted = [
    '英語学習の再開計画',
    '?チームに考える時間をどう確保するか',
    '旅行の候補地リスト、山側',
    '読みたい技術書3冊のメモ',
    'ブログのリニューアル構想',
    '筋トレメニューの見直し',
    '昔のプロジェクトの反省点、途中まで',
    '?なぜ日曜の夜に不安になるのか',
    '部屋の照明を暖色に変える案',
  ];
  drifted.forEach((text, i) => {
    add({ text, ageEco: 79000 - i * 4000, wallAgeH: 130 + i * 15, status: 'drifted' });
  });

  // ---------- 閉幕(惑星の断面に堆積順で眠る。一言=墓碑銘) ----------
  const closed: [string, number, string?][] = [
    ['保険の更新手続き', 2, '済'],
    ['請求書の支払い', 5],
    ['Kへの返信', 8, '送った'],
    ['?タイトルは英語か日本語か', 12, 'orbiterに決めた'],
    ['議事録の共有', 18],
    ['牛乳と卵', 22],
    ['歯医者の予約', 26, '金曜10時'],
    ['原稿の第一稿', 30, '荒いが出した'],
    ['?毎日書けるか', 38, '書けない日があっていい、が答え'],
    ['ゴミの分別ルール確認', 45],
    ['サーバー証明書の更新', 52, '自動化した'],
    ['母に電話', 60],
    ['プランターの植え替え', 68],
    ['読みかけの論文3本', 76, '2本は読まないと認めた'],
    ['?会議は減らせるか', 84, '隔週にした'],
    ['自転車のライト交換', 92],
    ['経費精算', 100],
    ['昔のブログの供養', 110, '読み返して閉じた。よく書いた'],
    ['パスワードの整理', 120],
    ['勉強会の資料', 130, '出し切った'],
    ['?完璧な構成を待つ癖', 140, '待たずに書く。以上'],
    ['窓の掃除', 152],
    ['確定申告の準備リスト', 164],
    ['靴の修理', 176],
    ['バックアップの確認', 190, '三重にした'],
    ['?メモアプリを作る意味はあるのか', 205, '作りながら考えることに意味があった'],
    ['年賀状じまいの文面', 220],
    ['ライブラリの更新', 235],
    ['古いToDoリストの棚卸し', 250, 'ほぼ全部もう要らなかった'],
    ['換気扇の掃除', 265],
    ['?積読は罪か', 280, '罪ではなく地層'],
    ['サブスク解約2件', 300, '月3千円回収'],
  ];
  closed.forEach(([text, agoH, note], i) => {
    add({
      text,
      ageEco: 70000 - i * 500,
      wallAgeH: agoH + 4,
      status: 'closed',
      closedAgoH: agoH,
      closedNote: note,
    });
  });

  return { ecoSeconds: E, themes, grains };
}
