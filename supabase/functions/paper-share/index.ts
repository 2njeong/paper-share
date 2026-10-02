import { createClient } from "npm:@supabase/supabase-js@2";

// ---- Config ----------------------------------------------------------
const NOTION_VERSION = "2026-03-11";
const NOTION_TOKEN = Deno.env.get("NOTION_TOKEN") ?? "";
// 논문 공유 DB의 data source ID (고정값 — NINT-Projects / 자동화 워크플로우 / 논문 공유)
const DATA_SOURCE_ID = "e26123dc-13d2-4653-b253-7cf93673f0d7";
const RESEARCH_TYPE_OPTIONS = [
  "RCT", "cohort", "case-control", "cross-sectional", "qualitative", "mixed-methods",
  "systematic-review", "meta-analysis", "scoping-review", "system-development", "methodology", "other",
];

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

class ToolError extends Error {}

// ---- Notion REST helpers ----------------------------------------------
function notionHeaders() {
  return {
    "Authorization": `Bearer ${NOTION_TOKEN}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

async function notionFetch(path: string, init: RequestInit = {}) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    ...init,
    headers: { ...notionHeaders(), ...(init.headers as Record<string, string> ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Notion API ${res.status}: ${body.slice(0, 500)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function queryDataSource(filter: unknown, maxResults = 100) {
  const results: any[] = [];
  let cursor: string | undefined;
  do {
    const body: Record<string, unknown> = { page_size: Math.min(100, maxResults) };
    if (filter) body.filter = filter;
    if (cursor) body.start_cursor = cursor;
    const data = await notionFetch(`/data_sources/${DATA_SOURCE_ID}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    results.push(...data.results);
    cursor = data.has_more && results.length < maxResults ? data.next_cursor : undefined;
  } while (cursor);
  return results.slice(0, maxResults);
}

// ---- Property parsing / building ---------------------------------------
function textProp(richTextArray: any[] | undefined): string {
  return (richTextArray ?? []).map((t: any) => t.plain_text ?? "").join("");
}
function titleOf(page: any): string {
  return textProp(page.properties["제목"]?.title);
}
function selectOf(page: any, prop: string): string | null {
  return page.properties[prop]?.select?.name ?? null;
}
function multiSelectOf(page: any, prop: string): string[] {
  return (page.properties[prop]?.multi_select ?? []).map((o: any) => o.name);
}
function pageUrl(page: any): string {
  return page.url;
}

// ---- Auth (팀원 식별은 전적으로 서버가 관리하는 API 키로만 한다. 노션 계정 유무와 무관) -------
async function hashKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function authenticate(req: Request): Promise<{ name: string } | null> {
  const key = req.headers.get("x-api-key");
  if (!key) return null;
  const hash = await hashKey(key);
  const { data, error } = await supabase
    .from("team_members")
    .select("name")
    .eq("api_key_hash", hash)
    .maybeSingle();
  if (error || !data) return null;
  return data as { name: string };
}

// ---- Tool: find_paper -----------------------------------------------------
async function findPaper(args: any) {
  const ors: any[] = [];
  if (args.pmid) ors.push({ property: "PMID", rich_text: { equals: String(args.pmid) } });
  if (args.doi) ors.push({ property: "DOI", rich_text: { equals: String(args.doi).toLowerCase() } });
  if (!ors.length) {
    if (!args.title) throw new ToolError("pmid, doi, title 중 하나는 필요합니다.");
    ors.push({ property: "제목", title: { equals: args.title } });
  }
  const filter = ors.length > 1 ? { or: ors } : ors[0];
  const pages = await queryDataSource(filter, 5);
  if (!pages.length) return { found: false };
  const page = pages[0];
  return { found: true, title: titleOf(page), url: pageUrl(page), sharers: multiSelectOf(page, "공유자") };
}

// ---- Tool: get_options -----------------------------------------------------
async function getOptions() {
  const ds = await notionFetch(`/data_sources/${DATA_SOURCE_ID}`);
  const topicOptions: string[] = (ds.properties["관련연구주제"]?.select?.options ?? []).map((o: any) => o.name);
  const tagOptions: string[] = (ds.properties["태그"]?.multi_select?.options ?? []).map((o: any) => o.name);

  const pages = await queryDataSource(undefined, 200);
  const topicCount = new Map<string, number>();
  const tagCount = new Map<string, number>();
  for (const p of pages) {
    const t = selectOf(p, "관련연구주제");
    if (t) topicCount.set(t, (topicCount.get(t) ?? 0) + 1);
    for (const tag of multiSelectOf(p, "태그")) tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1);
  }
  const byFreq = (names: string[], counts: Map<string, number>) =>
    [...new Set(names)].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));

  return {
    관련연구주제: byFreq(topicOptions, topicCount),
    태그: byFreq(tagOptions.length ? tagOptions : [...tagCount.keys()], tagCount),
  };
}

// ---- Tool: share_paper -----------------------------------------------------
function heading(text: string) {
  return { object: "block", type: "heading_3", heading_3: { rich_text: [{ text: { content: text } }] } };
}
function paragraph(text: string | undefined) {
  return {
    object: "block", type: "paragraph",
    paragraph: { rich_text: [{ text: { content: (text && text.trim()) || "논문에 명시 안 됨" } }] },
  };
}
function buildSummaryBlocks(name: string, args: any) {
  const today = new Date().toISOString().slice(0, 10);
  return [
    { object: "block", type: "heading_2", heading_2: { rich_text: [{ text: { content: `요약 — ${name}, ${today}` } }] } },
    heading("연구 질문"), paragraph(args.research_question),
    heading("방법"), paragraph(args.methods),
    heading("핵심 결과"), paragraph(args.key_results),
    heading("한계"), paragraph(args.limitations),
    heading("시사점"), paragraph(args.implications),
    { object: "block", type: "divider", divider: {} },
    { object: "block", type: "heading_2", heading_2: { rich_text: [{ text: { content: "추가 메모" } }] } },
  ];
}

async function sharePaper(args: any, caller: { name: string }) {
  if (!args.pmid && !args.doi) throw new ToolError("PMID 또는 DOI 중 하나는 필수입니다.");
  if (!args.comment || !String(args.comment).trim()) throw new ToolError("추천 코멘트는 필수입니다.");

  const studyType = RESEARCH_TYPE_OPTIONS.includes(args.study_type) ? args.study_type : "other";
  const topic = args.topic && String(args.topic).trim() ? String(args.topic).trim() : "기타";
  const tags = [...new Set((args.tags ?? []).map((t: string) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 10) as string[];

  let page: any = null;
  if (args.pmid) {
    const found = await queryDataSource({ property: "PMID", rich_text: { equals: String(args.pmid) } }, 1);
    page = found[0] ?? null;
  }
  if (!page && args.doi) {
    const found = await queryDataSource({ property: "DOI", rich_text: { equals: String(args.doi).toLowerCase() } }, 1);
    page = found[0] ?? null;
  }

  if (page) {
    const sharers = multiSelectOf(page, "공유자");
    if (sharers.includes(caller.name)) {
      throw new ToolError("이미 이 논문을 공유하셨습니다.");
    }
    const prevComment = textProp(page.properties["추천코멘트"]?.rich_text);
    const newComment = `${prevComment ? prevComment + "\n" : ""}${caller.name}: ${args.comment}`.slice(0, 2000);
    const mergedTags = [...new Set([...multiSelectOf(page, "태그"), ...tags])];
    const mergedSharers = [...sharers, caller.name];
    await notionFetch(`/pages/${page.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        properties: {
          "추천코멘트": { rich_text: [{ text: { content: newComment } }] },
          "태그": { multi_select: mergedTags.map((name) => ({ name })) },
          "공유자": { multi_select: mergedSharers.map((name) => ({ name })) },
          "최근공유일": { date: { start: new Date().toISOString() } },
        },
      }),
    });
    if (args.note && String(args.note).trim()) {
      await notionFetch(`/blocks/${page.id}/children`, {
        method: "PATCH",
        body: JSON.stringify({
          children: [{
            object: "block", type: "bulleted_list_item",
            bulleted_list_item: { rich_text: [{ text: { content: `${caller.name} (${new Date().toISOString().slice(0, 10)}): ${args.note}` } }] },
          }],
        }),
      });
    }
    return { action: "updated", url: pageUrl(page), title: titleOf(page) };
  }

  const properties: Record<string, unknown> = {
    "제목": { title: [{ text: { content: args.title || "(제목 없음)" } }] },
    "PMID": { rich_text: args.pmid ? [{ text: { content: String(args.pmid) } }] : [] },
    "DOI": { rich_text: args.doi ? [{ text: { content: String(args.doi).toLowerCase() } }] : [] },
    "저널": { rich_text: args.journal ? [{ text: { content: args.journal } }] : [] },
    "출판연도": args.year ? { number: Number(args.year) } : { number: null },
    "연구유형": { select: { name: studyType } },
    "관련연구주제": { select: { name: topic } },
    "태그": { multi_select: tags.map((name) => ({ name })) },
    "한줄요약": { rich_text: [{ text: { content: args.summary || "" } }] },
    "추천코멘트": { rich_text: [{ text: { content: `${caller.name}: ${args.comment}` } }] },
    "공유자": { multi_select: [{ name: caller.name }] },
    "최근공유일": { date: { start: new Date().toISOString() } },
  };
  if (args.link) (properties as any)["링크"] = { url: args.link };

  const created = await notionFetch(`/pages`, {
    method: "POST",
    body: JSON.stringify({
      parent: { type: "data_source_id", data_source_id: DATA_SOURCE_ID },
      properties,
      children: buildSummaryBlocks(caller.name, args),
    }),
  });
  return { action: "created", url: pageUrl(created), title: titleOf(created) };
}

// ---- Tool: search_papers -----------------------------------------------------
async function searchPapers(args: any) {
  const and: any[] = [];
  if (args.topic) and.push({ property: "관련연구주제", select: { equals: args.topic } });
  if (args.study_type) and.push({ property: "연구유형", select: { equals: args.study_type } });
  if (args.tags?.length) {
    const orTags = args.tags.map((t: string) => ({ property: "태그", multi_select: { contains: String(t).trim().toLowerCase() } }));
    and.push(orTags.length > 1 ? { or: orTags } : orTags[0]);
  }
  if (args.sharer) {
    and.push({ property: "공유자", multi_select: { contains: args.sharer } });
  }
  if (args.since) and.push({ property: "최근공유일", date: { on_or_after: args.since } });
  if (args.keyword) {
    const kw = args.keyword;
    and.push({
      or: [
        { property: "제목", title: { contains: kw } },
        { property: "한줄요약", rich_text: { contains: kw } },
        { property: "태그", multi_select: { contains: String(kw).toLowerCase() } },
      ],
    });
  }
  const filter = and.length ? (and.length > 1 ? { and } : and[0]) : undefined;
  const pages = await queryDataSource(filter, 30);

  const results = pages.map((p) => ({
    title: titleOf(p),
    summary: textProp(p.properties["한줄요약"]?.rich_text),
    tags: multiSelectOf(p, "태그"),
    topic: selectOf(p, "관련연구주제"),
    study_type: selectOf(p, "연구유형"),
    sharers: multiSelectOf(p, "공유자"),
    url: pageUrl(p),
  }));
  return { count: results.length, results };
}

// ---- MCP tool registry -----------------------------------------------------
const TOOLS = [
  {
    name: "find_paper",
    description: "PMID, DOI 또는 제목으로 이미 공유된 논문이 있는지 찾는다. 이미 있으면 누가 공유했는지 반환.",
    inputSchema: {
      type: "object",
      properties: { pmid: { type: "string" }, doi: { type: "string" }, title: { type: "string" } },
    },
  },
  {
    name: "get_options",
    description: "DB에 이미 등록된 관련연구주제·태그 옵션 목록을 사용 빈도순으로 반환한다.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "share_paper",
    description: "논문을 팀 공유 DB에 올린다. 이미 있으면 추천코멘트·태그·공유자만 추가하고 요약은 새로 만들지 않는다.",
    inputSchema: {
      type: "object",
      properties: {
        pmid: { type: "string" }, doi: { type: "string" }, title: { type: "string" },
        journal: { type: "string" }, year: { type: "number" }, link: { type: "string" },
        research_question: { type: "string" }, methods: { type: "string" },
        key_results: { type: "string" }, limitations: { type: "string" }, implications: { type: "string" },
        summary: { type: "string", description: "한줄요약" },
        study_type: { type: "string", enum: RESEARCH_TYPE_OPTIONS },
        tags: { type: "array", items: { type: "string" } },
        topic: { type: "string", description: "관련연구주제. 비우면 '기타'로 저장" },
        comment: { type: "string", description: "추천 코멘트 (필수, 사용자 문장 그대로)" },
        note: { type: "string", description: "추가 메모 (두 번째 이후 공유자가 보충할 때만)" },
      },
      required: ["comment"],
    },
  },
  {
    name: "search_papers",
    description: "조건으로 팀이 공유한 논문을 찾는다. 결과는 최대 30건.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        keyword: { type: "string" },
        study_type: { type: "string", enum: RESEARCH_TYPE_OPTIONS },
        sharer: { type: "string", description: "공유자 이름" },
        since: { type: "string", description: "YYYY-MM-DD, 최근공유일 기준" },
      },
    },
  },
];

async function handleToolCall(name: string, args: any, caller: { name: string }) {
  switch (name) {
    case "find_paper": return findPaper(args);
    case "get_options": return getOptions();
    case "share_paper": return sharePaper(args, caller);
    case "search_papers": return searchPapers(args);
    default: throw new ToolError(`알 수 없는 도구: ${name}`);
  }
}

// ---- JSON-RPC / MCP Streamable HTTP (stateless, JSON response mode) ----------
function jsonRpcResult(id: unknown, result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    headers: { "Content-Type": "application/json" },
  });
}
function jsonRpcError(id: unknown, code: number, message: string) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname.endsWith("/health")) {
    return new Response(JSON.stringify({ ok: true, server: "paper-share-mcp" }), {
      headers: { "Content-Type": "application/json" },
    });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let msg: any;
  try {
    msg = await req.json();
  } catch {
    return jsonRpcError(null, -32700, "Parse error");
  }

  const { jsonrpc, id, method, params } = msg ?? {};
  if (jsonrpc !== "2.0" || !method) {
    return jsonRpcError(id ?? null, -32600, "Invalid Request");
  }

  if (method === "notifications/initialized") {
    return new Response(null, { status: 202 });
  }

  if (method === "initialize") {
    return jsonRpcResult(id, {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      serverInfo: { name: "paper-share", version: "1.0.0" },
      capabilities: { tools: {} },
    });
  }

  if (method === "tools/list") {
    return jsonRpcResult(id, { tools: TOOLS });
  }

  if (method === "tools/call") {
    const caller = await authenticate(req);
    if (!caller) {
      return jsonRpcResult(id, {
        content: [{ type: "text", text: "인증 실패: API 키가 없거나 등록되지 않았습니다. x-api-key 헤더를 확인하세요." }],
        isError: true,
      });
    }
    try {
      const result = await handleToolCall(params?.name, params?.arguments ?? {}, caller);
      return jsonRpcResult(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
    } catch (e) {
      const text = e instanceof ToolError ? e.message : `오류: ${(e as Error).message}`;
      return jsonRpcResult(id, { content: [{ type: "text", text }], isError: true });
    }
  }

  return jsonRpcError(id ?? null, -32601, "Method not found");
});
