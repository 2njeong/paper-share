const NOTION_VERSION = "2026-03-11";
const NOTION_TOKEN = Deno.env.get("NOTION_TOKEN") ?? "";
const DATA_SOURCE_ID = "e26123dc-13d2-4653-b253-7cf93673f0d7";
const TEAMS_WEBHOOK_URL = Deno.env.get("TEAMS_WEBHOOK_URL") ?? "";
// 논문 공유 DB의 "이번 주" 뷰 (연구주제별로 묶음, 최근공유일 내림차순)
const WEEK_VIEW_URL =
  "https://app.notion.com/p/ec0c272ee67f41c2bda3ae7c6e24491f?v=3ecba8a3975a8156-81a0-000c58219753";

function notionHeaders() {
  return {
    "Authorization": `Bearer ${NOTION_TOKEN}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

async function queryRecent() {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const results: any[] = [];
  let cursor: string | undefined;
  do {
    const body: Record<string, unknown> = {
      page_size: 100,
      filter: { property: "최근공유일", date: { on_or_after: since } },
    };
    if (cursor) body.start_cursor = cursor;
    const res = await fetch(`https://api.notion.com/v1/data_sources/${DATA_SOURCE_ID}/query`, {
      method: "POST",
      headers: notionHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Notion API ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const data = await res.json();
    results.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return results;
}

function textProp(a: any[] | undefined) {
  return (a ?? []).map((t: any) => t.plain_text ?? "").join("");
}
function titleOf(p: any) {
  return textProp(p.properties["제목"]?.title);
}
function selectOf(p: any, prop: string) {
  return p.properties[prop]?.select?.name ?? null;
}
function multiSelectOf(p: any, prop: string) {
  return (p.properties[prop]?.multi_select ?? []).map((o: any) => o.name);
}
// Adaptive Card TextBlock은 markdown을 부분적으로 지원하지만 특수문자(*, _, [, ])는 이스케이프해야 안전함
function esc(s: string) {
  return (s ?? "").replace(/([\\`*_\[\]])/g, "\\$1");
}

function paperContainer(p: any, isFirstInCard: boolean) {
  const summary = textProp(p.properties["한줄요약"]?.rich_text);
  const comment = textProp(p.properties["추천코멘트"]?.rich_text);
  const tags = multiSelectOf(p, "태그");

  const facts: any[] = [];
  if (summary) facts.push({ title: "요약", value: esc(summary) });
  if (comment) facts.push({ title: "추천", value: esc(comment) });
  if (tags.length) facts.push({ title: "태그", value: esc(tags.join(", ")) });

  const items: any[] = [
    { type: "TextBlock", text: `📄 ${esc(titleOf(p))}`, weight: "bolder", wrap: true },
  ];
  if (facts.length) items.push({ type: "FactSet", facts, spacing: "small" });
  items.push({
    type: "TextBlock",
    text: `[🔗 노션에서 보기](${p.url})`,
    wrap: true, isSubtle: true, size: "small", spacing: "small",
  });

  return {
    type: "Container",
    spacing: "medium",
    separator: !isFirstInCard, // 두 번째 논문부터 위에 구분선
    items,
  };
}

function buildAdaptiveCard(pages: any[]) {
  const groups = new Map<string, any[]>();
  for (const p of pages) {
    const topic = selectOf(p, "관련연구주제") || "기타";
    if (!groups.has(topic)) groups.set(topic, []);
    groups.get(topic)!.push(p);
  }
  const body: any[] = [
    { type: "TextBlock", text: `📚 이번 주 공유 논문 (${pages.length}편)`, weight: "bolder", size: "medium", wrap: true },
  ];
  let isFirstGroup = true;
  for (const [topic, items] of groups) {
    body.push({
      type: "TextBlock", text: `${esc(topic)}`, weight: "bolder", color: "accent",
      wrap: true, spacing: "large", separator: !isFirstGroup,
    });
    items.forEach((p, idx) => {
      // 주제 제목 바로 아래 첫 논문은 구분선 없이(제목이 이미 구분 역할), 같은 주제의 두 번째 논문부터는 구분선
      body.push(paperContainer(p, idx === 0));
    });
    isFirstGroup = false;
  }
  body.push({
    type: "TextBlock", text: `[📂 논문 공유 DB로 바로가기](${WEEK_VIEW_URL})`,
    wrap: true, spacing: "large", separator: true,
  });
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    msteams: { width: "full" }, // Teams 전용 확장: 카드를 채널 폭 전체로 넓힘
    body,
  };
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname.endsWith("/health")) {
    return new Response(JSON.stringify({ ok: true, server: "paper-share-digest" }), {
      headers: { "Content-Type": "application/json" },
    });
  }
  const dryRun = url.searchParams.get("dry_run") === "1";
  try {
    const pages = await queryRecent();
    if (!pages.length) {
      return new Response(JSON.stringify({ posted: false, reason: "이번 주 공유된 논문 없음", count: 0 }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    const card = buildAdaptiveCard(pages);
    if (dryRun || !TEAMS_WEBHOOK_URL) {
      return new Response(
        JSON.stringify({ posted: false, reason: dryRun ? "dry_run" : "TEAMS_WEBHOOK_URL 미설정", count: pages.length, preview: card }),
        { headers: { "Content-Type": "application/json" } },
      );
    }
    const res = await fetch(TEAMS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(card),
    });
    const bodyText = await res.text();
    return new Response(
      JSON.stringify({ posted: res.ok, status: res.status, count: pages.length, teams_response: bodyText.slice(0, 300) }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ posted: false, error: (e as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
