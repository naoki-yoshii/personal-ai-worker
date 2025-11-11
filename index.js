// ==== Personal AI Worker - LINE × Notion（スマホ編集OK 完成版） ======================
// 機能:
// - LINE Webhook受信（テキスト / 位置 / 保存ボタン）
// - テキスト→プレビュー→保存（Notionにページ作成）
// - 位置キャッシュ（2時間）＋周辺ランチ（ダミー）
// - 保存先ルーティング:  todo:/タスク: → Tasks,  memo:/メモ: → Knowledge, それ以外は Tasks
// - 自然文「…アニメ一覧のnotionに記録して」→ DB名を検索して保存（初回だけ検索→IDをKVにキャッシュ）
// - "schema: DB名" で列名・型・選択肢一覧をLINEに返信
// - Notionの列型（status/select/multi_select/date/url/...）に自動追従して安全に保存
// 必要なSecrets: LINE_CHANNEL_TOKEN, NOTION_API_KEY, 既定DBなら NOTION_DB_TASKS / NOTION_DB_KNOWLEDGE
// =============================================================================

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // --- LINE Webhook 受信 ---
    if (req.method === 'POST' && url.pathname === '/line-webhook') {
      const body = await req.json().catch(() => ({}));
      const event = body?.events?.[0];
      if (!event) return new Response('ok');

      // 位置メッセージ：2時間キャッシュしてダミー候補を返す
      if (event.type === 'message' && event.message?.type === 'location') {
        const { latitude, longitude } = event.message;
        const userId = event.source?.userId || 'anon';
        await env.KV.put(
          `loc:${userId}`,
          JSON.stringify({ latitude, longitude, ts: Date.now() }),
          { expirationTtl: 7200 }
        );
        const results = await searchLunchDummy({ latitude, longitude, query: "ランチ" });
        await replyFlex(env, event.replyToken, toLunchFlex(results.slice(0, 6)));
        return new Response('ok');
      }

      // テキスト：近場検索 / スキーマ表示 / 自然文DB保存 / 既定ルーティング
      if (event.type === 'message' && event.message?.type === 'text') {
        const text = (event.message.text || '').trim();
        const userId = event.source?.userId || 'anon';

        // 「近く/ランチ」キーワード
        if (/近く|周辺|ランチ|ご飯|ラーメン|カレー/.test(text)) {
          const cached = await env.KV.get(`loc:${userId}`, { type: 'json' });
          if (!cached || Date.now() - cached.ts > 1000 * 60 * 120) {
            await replyText(env, event.replyToken, "近くのおすすめを出すには位置情報を送ってね！");
            await replyQuickLocation(env, event.replyToken);
            return new Response('ok');
          }
          const results = await searchLunchDummy({
            latitude: cached.latitude,
            longitude: cached.longitude,
            query: text
          });
          await replyFlex(env, event.replyToken, toLunchFlex(results.slice(0, 6)));
          return new Response('ok');
        }

        // スキーマ表示: "schema: アニメ一覧"
        if (/^schema:\s*/i.test(text)) {
          const name = text.replace(/^schema:\s*/i, '').trim();
          if (!name) {
            await replyText(env, event.replyToken, '使い方: schema: アニメ一覧');
            return new Response('ok');
          }
          try {
            const meta = await getDbMetaByName(env, name);
            const msg = formatSchemaList(meta);
            await replyText(env, event.replyToken, msg.slice(0, 4700)); // LINE上限ガード
          } catch (e) {
            console.log('SCHEMA ERROR', e?.stack || e);
            await replyText(env, event.replyToken, `DBを見つけられない/取得できないみたい。\n"${name}" が Integration に接続されているか、名前を確認してね。`);
          }
          return new Response('ok');
        }

        // 自然文: 「… アニメ一覧のnotionに記録して」
        const dbCmd = parseDbCommand(text);
        if (dbCmd) {
          try {
            const metaByName = await getDbMetaByName(env, dbCmd.dbName);   // /search→KVキャッシュ
            const props = buildAutoPropertiesForFreeText(dbCmd.content, metaByName);
            const normalized = { target_db: { byName: true, name: dbCmd.dbName }, properties: props };
            const previewId = crypto.randomUUID();
            await env.KV.put(`preview:${previewId}`, JSON.stringify(normalized), { expirationTtl: 600 });
            await replyFlex(env, event.replyToken, toPreviewFlex(normalized, previewId));
          } catch (e) {
            console.log('DBNAME SAVE PREVIEW ERROR', e?.stack || e);
            await replyText(env, event.replyToken, `ごめん、そのDBが見つからないか接続されてないみたい：${dbCmd.dbName}`);
          }
          return new Response('ok');
        }

        // 既定ルーティング（todo:/memo:）
        const route = routeTarget(text);
        const cleanText = route.cleaned;
        try {
          const meta = await getDbMeta(env, route.target_db);
          const previewProps = buildPropertiesForDb(route.target_db, cleanText, meta);
          const normalized = { target_db: route.target_db, properties: previewProps };
          const previewId = crypto.randomUUID();
          await env.KV.put(`preview:${previewId}`, JSON.stringify(normalized), { expirationTtl: 600 });
          await replyFlex(env, event.replyToken, toPreviewFlex(normalized, previewId));
        } catch (e) {
          console.log('DEFAULT PREVIEW ERROR', e?.stack || e);
          await replyText(env, event.replyToken, `保存先DB (${route.target_db}) の設定が見つからないか、権限エラーかも。`);
        }
        return new Response('ok');
      }

      // 保存ボタン（postback）
      if (event.type === 'postback' && event.postback?.data?.startsWith('save:')) {
        const id = event.postback.data.split(':')[1];
        try {
          const data = await env.KV.get(`preview:${id}`, { type: "json" });
          if (!data) {
            await replyText(env, event.replyToken, '保存期限が切れました。もう一度送ってね');
            return new Response('ok');
          }
          console.log("SAVE DATA:", JSON.stringify(data));
          const url = await saveToNotion(env, data);
          await replyText(env, event.replyToken, `保存したよ！\n${url ?? ''}`);
        } catch (e) {
          console.log('SAVE ERROR', e?.stack || e);
          await replyText(env, event.replyToken, 'Notionへの保存に失敗したみたい。DBの接続・ID・列名/型を確認してもう一度！');
        }
        return new Response('ok');
      }

      return new Response('ok');
    }

    // 将来のCron用
    if (url.pathname === '/cron') return new Response('ok');

    return new Response('ok');
  }
};

// ===== ルーティング =====
function routeTarget(text) {
  const lower = text.toLowerCase();
  if (lower.startsWith('todo:') || text.startsWith('タスク:')) {
    return { target_db: 'Tasks', cleaned: text.replace(/^todo:|^タスク:/i, '').trim() };
  }
  if (lower.startsWith('memo:') || text.startsWith('メモ:')) {
    return { target_db: 'Knowledge', cleaned: text.replace(/^memo:|^メモ:/i, '').trim() };
  }
  return { target_db: 'Tasks', cleaned: text };
}

// ===== LINE送信ヘルパ =====
async function replyText(env, replyToken, text) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.LINE_CHANNEL_TOKEN}` },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] })
  });
  const body = await res.text();
  if (!res.ok) console.log('LINE replyText ERROR', res.status, body);
}
async function replyFlex(env, replyToken, contents) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.LINE_CHANNEL_TOKEN}` },
    body: JSON.stringify({ replyToken, messages: [{ type: 'flex', altText: 'プレビュー', contents }] })
  });
  const body = await res.text();
  if (!res.ok) {
    console.log('LINE replyFlex ERROR', res.status, body);
    await replyText(env, replyToken, 'プレビュー送信に失敗したのでテキストで返します：\n' + JSON.stringify(contents).slice(0, 800));
  }
}
async function replyQuickLocation(env, replyToken) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.LINE_CHANNEL_TOKEN}` },
    body: JSON.stringify({
      replyToken,
      messages: [{
        type: 'text',
        text: '現在地を送ってください',
        quickReply: { items: [{ type: 'action', action: { type: 'location', label: '現在地を送る' } }] }
      }]
    })
  });
}

// ===== ダミーの周辺ランチ =====
async function searchLunchDummy({ latitude, longitude }) {
  return [
    { name: "麺やサンプル", rating: 4.2, photo: "https://picsum.photos/800/450", url: `https://maps.google.com/?q=${latitude},${longitude}`, distance: "徒歩6分", hours: "11:00-15:00,17:00-21:00" },
    { name: "カレー例",     rating: 4.0, photo: "https://picsum.photos/801/450", url: `https://maps.google.com/?q=${latitude},${longitude}`, distance: "徒歩8分", hours: "11:00-20:00" },
    { name: "定食サンプル", rating: 4.1, photo: "https://picsum.photos/802/450", url: `https://maps.google.com/?q=${latitude},${longitude}`, distance: "徒歩4分", hours: "11:00-21:00" },
  ];
}
function toLunchFlex(items) {
  return {
    type: "carousel",
    contents: items.map(x => ({
      type: "bubble",
      hero: { type: "image", url: x.photo, size: "full", aspectMode: "cover", aspectRatio: "16:9" },
      body: {
        type: "box", layout: "vertical", contents: [
          { type: "text", text: x.name, weight: "bold", size: "lg" },
          { type: "text", text: `★${x.rating ?? "-"} ・ ${x.distance ?? ""}`, size: "sm", color: "#888888" },
          { type: "text", text: `営業時間：${x.hours ?? "不明"}`, size: "sm", wrap: true }
        ]
      },
      footer: { type: "box", layout: "vertical", contents: [{ type: "button", style: "link", action: { type: "uri", label: "Googleマップで開く", uri: x.url } }] }
    }))
  };
}

// ===== プレビュー（保存ボタン付き） =====
function toPreviewFlex(normalized, previewId) {
  const props = normalized.properties || {};
  const lines = Object.entries(props)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : typeof v === 'object' ? JSON.stringify(v) : v}`)
    .slice(0, 10);

  const dbLabel = (typeof normalized.target_db === 'string')
    ? normalized.target_db
    : `${normalized.target_db?.name ?? 'Unknown'} (by name)`;

  return {
    type: "bubble",
    body: {
      type: "box", layout: "vertical", contents: [
        { type: "text", text: `DB: ${dbLabel}`, weight: "bold", size: "md" },
        ...lines.map(t => ({ type: "text", text: t, wrap: true })),
        { type: "separator", margin: "md" },
        { type: "text", text: "OKなら保存を押してね。修正があれば続けて送ってください。", wrap: true }
      ]
    },
    footer: {
      type: "box", layout: "horizontal", spacing: "md", contents: [
        { type: "button", style: "primary", action: { type: "postback", label: "保存", data: `save:${previewId}` } },
        { type: "button", style: "secondary", action: { type: "message", label: "修正する", text: "修正: ここに変更点を書いて" } }
      ]
    }
  };
}

// ===== Notion：DBメタ（既定/ID/名前） =====
async function getDbMeta(env, target_db) {
  const dbId = env[`NOTION_DB_${target_db.toUpperCase()}`];
  if (!dbId) throw new Error(`No DB id for target_db=${target_db}`);
  return await getDbMetaById(env, dbId);
}
async function getDbMetaById(env, dbIdRaw) {
  const dbId = (dbIdRaw || '').replace(/-/g, '');
  const r = await fetch(`https://api.notion.com/v1/databases/${dbId}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${env.NOTION_API_KEY}`,
      'Notion-Version': '2022-06-28'
    }
  });
  const txt = await r.text();
  if (!r.ok) {
    console.log('NOTION GET DB META ERROR', r.status, txt);
    throw new Error(`Failed to fetch DB meta: ${r.status}`);
  }
  const meta = JSON.parse(txt);
  const titlePropEntry = Object.entries(meta.properties).find(([, v]) => v?.type === 'title');
  const titlePropName = titlePropEntry ? titlePropEntry[0] : 'Name';
  return {
    dbId: meta.id.replace(/-/g, ''),
    dbTitle: getTitlePlain(meta.title),
    titlePropName,
    schema: meta.properties,
    propertyNames: new Set(Object.keys(meta.properties))
  };
}
async function getDbMetaByName(env, dbName) {
  // KVキャッシュ優先
  const cacheKey = `dbid:${dbName}`;
  let dbId = await env.KV.get(cacheKey);
  if (!dbId) {
    const found = await searchDatabaseByName(env, dbName);
    if (!found) throw new Error(`Database not found by name: ${dbName}`);
    dbId = found.id.replace(/-/g, '');
    await env.KV.put(cacheKey, dbId, { expirationTtl: 60 * 60 * 24 * 30 });
  }
  return await getDbMetaById(env, dbId);
}
async function searchDatabaseByName(env, name) {
  const r = await fetch('https://api.notion.com/v1/search', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.NOTION_API_KEY}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    },
    body: JSON.stringify({
      query: name,
      filter: { property: 'object', value: 'database' },
      sort: { direction: 'descending', timestamp: 'last_edited_time' }
    })
  });
  const txt = await r.text();
  if (!r.ok) {
    console.log('NOTION SEARCH ERROR', r.status, txt);
    throw new Error(`Search failed: ${r.status}`);
  }
  const res = JSON.parse(txt);
  const exact = res.results?.find(db => getTitlePlain(db.title) === name);
  return exact || res.results?.[0];
}
function getTitlePlain(titleArray) {
  if (!Array.isArray(titleArray)) return '';
  return titleArray.map(t => t?.plain_text || '').join('').trim();
}

// ===== Notion 保存（型自動対応） =====
async function saveToNotion(env, payload) {
  let meta;
  const { target_db, properties } = payload || {};
  if (typeof target_db === 'string') {
    meta = await getDbMeta(env, target_db);               // 既定DB（NOTION_DB_*）
  } else if (target_db?.byName && target_db?.name) {
    meta = await getDbMetaByName(env, target_db.name);    // DB名から解決（/search→KV）
  } else {
    throw new Error('target_db not resolvable');
  }

  const mapped = mapToNotionPropsWithTitle(properties, meta.titlePropName, meta.schema);

  const r = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.NOTION_API_KEY}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    },
    body: JSON.stringify({ parent: { database_id: meta.dbId }, properties: mapped })
  });
  const createText = await r.text();
  if (!r.ok) {
    console.log('NOTION CREATE ERROR', r.status, createText);
    throw new Error(`Notion create failed: ${r.status}`);
  }
  const j = JSON.parse(createText);
  console.log('NOTION CREATE OK', j.url);
  return j?.url;
}

// スキーマ型に合わせて安全にマッピング
function mapToNotionPropsWithTitle(inputProps, titlePropName, schema) {
  const out = {};
  let titleSet = false;
  const hasProp = (k) => (k === titlePropName) || Object.prototype.hasOwnProperty.call(schema || {}, k);

  for (const [k, vRaw] of Object.entries(inputProps || {})) {
    if (k !== titlePropName && !hasProp(k)) continue;

    const v = vRaw;
    const type = (k === titlePropName) ? 'title' : schema?.[k]?.type;

    switch (type) {
      case 'title':
        out[titlePropName] = { title: [{ text: { content: String(v) } }] };
        titleSet = true;
        break;
      case 'select':
        out[k] = { select: v ? { name: String(v) } : null };
        break;
      case 'status':
        out[k] = { status: v ? { name: String(v) } : null };
        break;
      case 'multi_select':
        out[k] = { multi_select: Array.isArray(v) ? v.map(x => ({ name: String(x) })) : [] };
        break;
      case 'rich_text':
        out[k] = { rich_text: [{ text: { content: String(v ?? '') } }] };
        break;
      case 'date':
        out[k] = { date: v ? { start: String(v) } : null };
        break;
      case 'url':
        out[k] = { url: v ? String(v) : null };
        break;
      case 'email':
        out[k] = { email: v ? String(v) : null };
        break;
      case 'phone_number':
        out[k] = { phone_number: v ? String(v) : null };
        break;
      case 'number':
        out[k] = { number: (v === '' || v === null || v === undefined) ? null : Number(v) };
        break;
      case 'checkbox':
        out[k] = { checkbox: Boolean(v) };
        break;
      case 'people':
        // people型は { people: [{ id: "…" }, ...] } 必須。文字列は無視して安全スキップ
        if (Array.isArray(v) && v.every(x => typeof x === 'object' && x.id)) {
          out[k] = { people: v };
        }
        break;
      default:
        // 未対応/不明型は送らない（安全スキップ）
        break;
    }
  }

  if (!titleSet) {
    const first = Object.values(inputProps || {})[0] ?? "(無題)";
    out[titlePropName] = { title: [{ text: { content: String(first) } }] };
  }
  return out;
}

// ===== DBごとの既定プロパティ組み立て =====
function buildPropertiesForDb(target_db, text, meta) {
  const props = {};
  props[meta.titlePropName] = extractTitleCandidate(text);

  if (target_db === 'Tasks') {
    if (meta.schema['Status']?.type)   props['Status'] = '未着手';
    if (meta.schema['Priority']?.type) props['Priority'] = '中';
    if (meta.schema['Summary']?.type)  props['Summary']  = text;
  } else if (target_db === 'Knowledge') {
    if (meta.schema['Summary']?.type)  props['Summary'] = text;
    if (meta.schema['Category']?.type) props['Category'] = 'メモ';
  }
  return props;
}

// ===== 自然文→DB名・本文抽出 =====
function parseDbCommand(text) {
  // 末尾の「◯◯のnotionに記録して/登録して/保存して」を検出
  const m = text.match(/(.+?)\s*[のノ]\s*(?:notion|ノーション)\s*に\s*(?:記録|登録|保存)(?:して|してね|してください)?[。.!！]?$/i);
  if (!m) return null;
  const before = m[1].trim();
  // “… アニメ一覧 のnotionに …” の “アニメ一覧” をDB名として推定
  const nameMatch = before.match(/([^\s。．、,]+)$/);
  const dbName = nameMatch ? nameMatch[1] : before;

  const content = text.replace(m[0], '').trim();
  return { dbName, content: (content || before).trim() };
}

// ===== 自由文→DBのスキーマに合わせて自動プロパティ化 =====
function buildAutoPropertiesForFreeText(content, meta) {
  const props = {};
  const title = extractTitleCandidate(content);
  props[meta.titlePropName] = title;

  // 感想/メモ（rich_text）
  const rtName = pickFirstProp(meta.schema, ['感想','レビュー','コメント','メモ','Summary','備考'], 'rich_text');
  if (rtName) props[rtName] = content;

  // 視聴日/日付（date）
  const dateName = pickFirstProp(meta.schema, ['視聴日','日付','Date','Watched At','Watched'], 'date');
  if (dateName) props[dateName] = new Date().toISOString().slice(0,10); // YYYY-MM-DD

  // 作品名（rich_text が別にある場合）
  const nameProp = pickFirstProp(meta.schema, ['作品名','タイトル','作品','Name'], 'rich_text');
  if (nameProp && !props[nameProp]) props[nameProp] = title;

  // 評価（number）…文中に数値があれば
  const ratingNum = (content.match(/(\d+(\.\d+)?)[点⭐★]?/))?.[1];
  const ratingNumberProp = findPropByType(meta.schema, 'number', ['評価','Rating','スコア']);
  if (ratingNumberProp && ratingNum) props[ratingNumberProp] = Number(ratingNum);

  // カテゴリ（select）
  const catProp = findPropByType(meta.schema, 'select', ['カテゴリ','カテゴリー','Category']);
  if (catProp) props[catProp] = '視聴';

  return props;
}
function extractTitleCandidate(text) {
  const s = (text || '').replace(/\s+/g,' ').trim();
  const cut = s.split(/[。.!！?？\n]/)[0];
  return (cut && cut.length >= 2) ? cut.slice(0, 60) : s.slice(0, 60) || '(無題)';
}
function pickFirstProp(schema, candidates, wantType) {
  for (const name of candidates) {
    const p = schema[name];
    if (p?.type === wantType) return name;
  }
  return null;
}
function findPropByType(schema, wantType, preferredNames=[]) {
  const picked = pickFirstProp(schema, preferredNames, wantType);
  if (picked) return picked;
  for (const [k,v] of Object.entries(schema)) {
    if (v?.type === wantType) return k;
  }
  return null;
}

// ===== スキーマ表示フォーマット =====
function formatSchemaList(meta) {
  const lines = [];
  lines.push(`DB: ${meta.dbTitle || '(無題DB)'}`);
  lines.push(`ID: ${meta.dbId}`);
  lines.push(`Title列: ${meta.titlePropName}`);
  lines.push('— 列一覧 —');
  for (const [name, def] of Object.entries(meta.schema || {})) {
    const type = def?.type || 'unknown';
    let extra = '';
    if (type === 'select') {
      const opts = def.select?.options?.map(o => o.name).filter(Boolean) || [];
      extra = opts.length ? ` [${opts.join(', ')}]` : '';
    } else if (type === 'multi_select') {
      const opts = def.multi_select?.options?.map(o => o.name).filter(Boolean) || [];
      extra = opts.length ? ` [${opts.join(', ')}]` : '';
    } else if (type === 'status') {
      const opts = def.status?.options?.map(o => o.name).filter(Boolean) || [];
      extra = opts.length ? ` [${opts.join(', ')}]` : '';
    }
    lines.push(`・${name} : ${type}${extra}`);
  }
  return lines.join('\n');
}