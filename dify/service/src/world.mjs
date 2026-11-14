// Static world seed served by `GET /api/world`.
//
// The knowledge base (Dify / seekdb vectors) holds the *rules*; this file holds
// the *facts* the session service can hand back to the chatflow without a
// database round-trip — room coordinates, NPC one-liners, and the item table.

export const WORLD = {
  name: "迷宮酒館",
  tavern: "醉月",
  rooms: {
    燭火廳: {
      id: "tavern_hall",
      exits: ["階梯井", "後巷"],
      summary: "狹長的廳堂，兩排桌，桌上蠟燭永遠只點三盞。",
      smells: ["酒味", "灰燼味", "淡淡的鐵鏽味"],
    },
    後巷: {
      id: "back_alley",
      exits: ["燭火廳", "藏書室"],
      summary: "堆著空酒桶，一隻不怕人的白貓。雨從縫隙落下，水窪裡的水是向上的。",
    },
    藏書室: {
      id: "library",
      exits: ["後巷"],
      summary: "三面書架，只有中間一面是真的書。",
    },
    階梯井: {
      id: "stairwell",
      exits: ["燭火廳", "鹽走廊"],
      summary: "七層樓梯，每層都通往不同的方向。",
    },
    鹽走廊: {
      id: "salt_corridor",
      exits: ["階梯井", "蠟燭長廊"],
      summary: "牆上覆著粗鹽，腳印踩上去會發出玻璃碎裂的聲音。",
    },
    蠟燭長廊: {
      id: "candle_hall",
      exits: ["鹽走廊", "月門"],
      summary: "整條走廊都點著蠟燭，火焰是藍色的，且風吹不熄。",
    },
    月門: {
      id: "moon_gate",
      exits: ["蠟燭長廊"],
      summary: "嵌在牆上的門，門框是骨頭色的，門內透出不是陽光的光。",
    },
  },
  npcs: {
    老霍: {
      role: "館主",
      tell: "左手缺了兩根指頭，圍裙永遠是同一條。",
      knows: "月門在第八層的東側；他賣過八份星圖，但只有一份是完整的。",
      hook: "只要提到「門」，他會停下擦杯子的動作。",
    },
    月亮的守門人: {
      role: "醉客",
      tell: "披斗篷，帽沿壓得很低，左手缺了兩根指頭。",
      knows: "他是上一任館主，被織夢者換了名字。",
      hook: "需要 `met_keeper` 為 true 且出示「館主的名片」。",
    },
    織夢者: {
      role: "迷宮的免疫系統",
      tell: "像一大團被水浸透的絲綢，中間有一盞不熄的燈。",
      knows: "牠收藏每一個走進來的人的名字。",
      hook: "每句不超過十個字；不會說謊，但會用歧義。",
    },
  },
  items: {
    銅鑰匙: "開啟第七層的木門",
    半張星圖: "與另一半拼合後指出月門方向",
    蠟燭殘根: "熄滅後可讓迷宮重排暫停一回合",
    館主的名片: "讓酒館內 NPC 對你放下戒心",
    銀幣袋: "gold + 12",
  },
  prices: {
    房錢: 3,
    訊息: 3,
  },
  start: {
    location: "燭火廳",
    gold: 8,
    hp: 20,
    hp_max: 20,
    stats: { str: 3, agi: 4, int: 5, wil: 4 },
  },
};
