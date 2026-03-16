/**
 * Cloudflare Workers entry point for Proof SDK.
 *
 * Routes incoming requests to static assets, the D1 document catalog,
 * or per-document Durable Objects. Each document gets its own DO instance
 * for state isolation and collab.
 */

import { DocumentSession } from "./document-session.js";

export { DocumentSession };

/** Cloudflare bindings: Durable Objects, D1, and static assets. */
export interface Env {
  DOCUMENT_SESSION: DurableObjectNamespace<DocumentSession>;
  CATALOG_DB: D1Database;
  ASSETS: Fetcher;
  PROOF_API_KEY?: string;
}

/** Check if the request has a valid API key. Returns true if no key is configured (open mode). */
function checkApiKey(request: Request, env: Env): boolean {
  if (!env.PROOF_API_KEY) return true;
  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    return auth.slice(7) === env.PROOF_API_KEY;
  }
  // Also accept ?key= query param (needed for browser-based access like /dashboard)
  const url = new URL(request.url);
  const keyParam = url.searchParams.get("key");
  if (keyParam) {
    return keyParam === env.PROOF_API_KEY;
  }
  return false;
}

function unauthorizedResponse(): Response {
  return Response.json(
    { error: "Unauthorized", message: "Valid API key required. Use Authorization: Bearer <key>" },
    { status: 401 },
  );
}

const SLUG_LENGTH = 8;
const SLUG_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

function generateSlug(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SLUG_LENGTH));
  let slug = "";
  for (let i = 0; i < SLUG_LENGTH; i++) {
    slug += SLUG_CHARS[bytes[i] % SLUG_CHARS.length];
  }
  return slug;
}

/** Row shape returned by the documents query for the dashboard. */
interface DashboardRow {
  slug: string;
  title: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** Format an ISO timestamp into a human-readable string (Eastern Time). */
function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** Escape HTML entities to prevent XSS in rendered values. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Render the dashboard auth prompt page (shown when no valid key is provided). */
function renderDashboardAuth(origin: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Proof Dashboard — Sign In</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #0f0f0f; color: #e0e0e0;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; padding: 1rem;
    }
    .card {
      background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 12px;
      padding: 2.5rem; max-width: 400px; width: 100%;
    }
    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.5rem; }
    p { color: #888; font-size: 0.875rem; margin-bottom: 1.5rem; }
    label { display: block; font-size: 0.8rem; color: #999; margin-bottom: 0.4rem; }
    input {
      width: 100%; padding: 0.6rem 0.75rem; background: #111; border: 1px solid #333;
      border-radius: 6px; color: #e0e0e0; font-size: 0.9rem; outline: none;
    }
    input:focus { border-color: #555; }
    button {
      margin-top: 1rem; width: 100%; padding: 0.65rem; background: #fff; color: #000;
      border: none; border-radius: 6px; font-size: 0.9rem; font-weight: 500;
      cursor: pointer;
    }
    button:hover { background: #e0e0e0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Proof Dashboard</h1>
    <p>Enter your API key to view documents.</p>
    <form method="GET" action="${escapeHtml(origin)}/dashboard">
      <label for="key">API Key</label>
      <input type="password" id="key" name="key" required autocomplete="off" placeholder="your-api-key">
      <button type="submit">Sign In</button>
    </form>
  </div>
</body>
</html>`;
}

/** Render the full dashboard HTML page. */
function renderDashboard(rows: DashboardRow[], origin: string, key: string): string {
  const rowsHtml = rows.length === 0
    ? `<tr><td colspan="4" style="text-align:center;padding:2rem;color:#666;">No documents yet. Create one from the API or visit <a href="${escapeHtml(origin)}/" style="color:#7ab3ff;">the editor</a>.</td></tr>`
    : rows.map((row) => {
        const title = row.title?.trim() || "Untitled";
        const docUrl = `/d/${escapeHtml(row.slug)}`;
        return `<tr>
          <td><a href="${docUrl}" class="doc-link">${escapeHtml(title)}</a></td>
          <td class="mono">${escapeHtml(row.slug)}</td>
          <td class="date">${formatDate(row.created_at)}</td>
          <td><a href="${docUrl}" class="open-btn">Open</a></td>
        </tr>`;
      }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Proof Dashboard</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #0f0f0f; color: #e0e0e0; padding: 2rem; min-height: 100vh;
    }
    .container { max-width: 960px; margin: 0 auto; }
    header {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 1px solid #222;
    }
    h1 { font-size: 1.5rem; font-weight: 600; }
    .count { color: #666; font-size: 0.85rem; }
    table { width: 100%; border-collapse: collapse; }
    th {
      text-align: left; padding: 0.6rem 0.75rem; font-size: 0.75rem;
      text-transform: uppercase; letter-spacing: 0.05em; color: #666;
      border-bottom: 1px solid #222;
    }
    td {
      padding: 0.75rem; border-bottom: 1px solid #1a1a1a;
      font-size: 0.9rem; vertical-align: middle;
    }
    tr:hover td { background: #141414; }
    .doc-link {
      color: #e0e0e0; text-decoration: none; font-weight: 500;
    }
    .doc-link:hover { color: #fff; text-decoration: underline; }
    .mono { font-family: "SF Mono", "Fira Code", monospace; font-size: 0.8rem; color: #888; }
    .date { color: #888; font-size: 0.85rem; white-space: nowrap; }
    .open-btn {
      display: inline-block; padding: 0.3rem 0.75rem; background: #1e1e1e;
      border: 1px solid #333; border-radius: 5px; color: #aaa;
      text-decoration: none; font-size: 0.8rem; transition: all 0.15s;
    }
    .open-btn:hover { background: #2a2a2a; color: #fff; border-color: #555; }
    @media (max-width: 640px) {
      body { padding: 1rem; }
      .date { display: none; }
      th:nth-child(3), td:nth-child(3) { display: none; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Proof Dashboard</h1>
      <span class="count">${rows.length} document${rows.length === 1 ? "" : "s"}</span>
    </header>
    <table>
      <thead>
        <tr>
          <th>Title</th>
          <th>Slug</th>
          <th>Created</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>
  </div>
</body>
</html>`;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Health check
    if (path === "/health") {
      return new Response("OK", { status: 200 });
    }

    // Dashboard — browser-friendly document list
    if (path === "/dashboard" && request.method === "GET") {
      if (!checkApiKey(request, env)) {
        return new Response(renderDashboardAuth(url.origin), {
          status: 401,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      const keyParam = url.searchParams.get("key") ?? "";
      const { results } = await env.CATALOG_DB.prepare(
        "SELECT slug, title, created_at, updated_at FROM documents ORDER BY created_at DESC",
      ).all();
      return new Response(renderDashboard(results as unknown as DashboardRow[], url.origin, keyParam), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // Agent discovery
    if (path === "/.well-known/agent.json") {
      const base = url.origin;
      return Response.json({
        name: "Proof Editor",
        description: "Agent-native markdown editor with collaborative sharing and provenance tracking",
        api_base: `${base}/api`,
        capabilities: ["create_document", "share", "comment", "suggest", "rewrite", "collab", "provenance"],
        auth: {
          methods: ["api_key", "none"],
          api_key_header: "Authorization: Bearer <key>",
          no_auth_allowed: true,
          shared_link: {
            token_from_url: "?token=<token>",
            preferred_header: "x-share-token",
            alt_header: "x-bridge-token",
          },
        },
        quickstart: {
          received_link: {
            description: "Given a Proof share URL, read it in one step",
            method: "GET",
            url: "/api/agent/{slug}/state",
            headers: { "x-share-token": "{token}" },
            returns: "markdown + marks + _links",
          },
          create_and_share: {
            method: "POST",
            url: "/documents",
            body: { title: "My Document" },
            returns: "slug + url",
          },
        },
      }, {
        headers: { "cache-control": "public, max-age=300" },
      });
    }

    // Root → create a new document and redirect to /d/:slug
    if (path === "/") {
      if (!checkApiKey(request, env)) return unauthorizedResponse();
      const slug = generateSlug();
      const doId = env.DOCUMENT_SESSION.idFromName(slug).toString();
      await env.CATALOG_DB.prepare(
        "INSERT INTO documents (id, slug, title, do_id) VALUES (?, ?, ?, ?)",
      )
        .bind(doId, slug, "", doId)
        .run();
      return Response.redirect(new URL(`/d/${slug}?new=1`, url.origin).toString(), 302);
    }

    // Document editor — serve the SPA for /d/:slug
    const docPageMatch = path.match(/^\/d\/([^/]+)\/?$/);
    if (docPageMatch) {
      const slug = decodeURIComponent(docPageMatch[1]);
      // Fetch index.html via the static assets binding, then rewrite
      // relative paths to absolute so ./assets/editor.js doesn't resolve
      // to /d/assets/editor.js
      const assetResponse = await env.ASSETS.fetch(
        new Request(new URL("/index.html", url.origin)),
      );
      let html = await assetResponse.text();
      html = html.replaceAll('"./', '"/').replaceAll("'./", "'/");

      // Hide the "Saved"/"Saving" text label — keep only the green dot.
      // Inject "Export as .md" into the Share dropdown menu.
      const injectedHead = `<style>
#share-banner .share-pill-status-inline .status-label{display:none!important;}
</style>
<script>
(function(){
  function downloadMd(){
    var pe=window.__PROOF_EDITOR__;
    if(!pe||!pe.getMarkdown)return;
    var md=pe.getMarkdown();
    if(!md)return;
    var title=document.title.replace(/[^a-zA-Z0-9 _-]/g,'').trim()||'document';
    var blob=new Blob([md],{type:'text/markdown'});
    var a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download=title+'.md';
    a.click();
    URL.revokeObjectURL(a.href);
  }
  function injectExportItem(menu){
    if(menu.querySelector('[data-export-md]'))return;
    var hr=document.createElement('div');
    hr.style.cssText='height:1px;background:rgba(255,255,255,0.10);margin:6px 6px';
    var item=document.createElement('button');
    item.type='button';
    item.setAttribute('role','menuitem');
    item.setAttribute('data-export-md','1');
    item.style.cssText='width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;min-height:44px;border-radius:10px;border:0;background:transparent;color:rgba(255,255,255,0.82);font-size:12px;font-weight:500;cursor:pointer;text-align:left;';
    item.onmouseenter=function(){item.style.background='rgba(255,255,255,0.08)';};
    item.onmouseleave=function(){item.style.background='transparent';};
    var left=document.createElement('span');
    left.textContent='Export as .md';
    var right=document.createElement('span');
    right.textContent='\\u2193';
    right.style.cssText='font-weight:700;opacity:0.8';
    item.append(left,right);
    item.onclick=function(e){e.stopPropagation();downloadMd();left.textContent='Downloaded';setTimeout(function(){left.textContent='Export as .md';},1200);};
    menu.appendChild(hr);
    menu.appendChild(item);
  }
  document.addEventListener('click',function(){
    setTimeout(function(){
      var menus=document.querySelectorAll('.share-pill-share-btn [role=menu]');
      menus.forEach(function(menu){injectExportItem(menu);});
    },50);
  },true);
})();
</script>`;
      html = html.replace("</head>", `${injectedHead}</head>`);

      // When arriving from doc creation (?new=1), suppress the "shared with
      // you" welcome toast and name prompt — the user is the creator, not a
      // share recipient.
      const isNewDoc = url.searchParams.get("new") === "1";
      if (isNewDoc) {
        const suppressScript = `<script>try{sessionStorage.setItem("proof_share_welcome_${slug}","1")}catch(e){}</script>`;
        html = html.replace("</head>", `${suppressScript}</head>`);
      }

      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // POST /documents — API document creation
    if (path === "/documents" && request.method === "POST") {
      if (!checkApiKey(request, env)) return unauthorizedResponse();
      const slug = generateSlug();
      const doId = env.DOCUMENT_SESSION.idFromName(slug).toString();
      await env.CATALOG_DB.prepare(
        "INSERT INTO documents (id, slug, title, do_id) VALUES (?, ?, ?, ?)",
      )
        .bind(doId, slug, "", doId)
        .run();
      return new Response(
        JSON.stringify({ success: true, slug, url: `/d/${slug}` }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }

    // GET /documents — list all documents from D1 catalog
    if (path === "/documents" && request.method === "GET") {
      if (!checkApiKey(request, env)) return unauthorizedResponse();
      const { results } = await env.CATALOG_DB.prepare(
        "SELECT slug, title, created_at, updated_at FROM documents ORDER BY created_at DESC",
      ).all();
      return Response.json({ documents: results });
    }

    // POST /share/markdown or /api/share/markdown — create doc from raw markdown
    if ((path === "/share/markdown" || path === "/api/share/markdown") && request.method === "POST") {
      if (!checkApiKey(request, env)) return unauthorizedResponse();
      const contentType = request.headers.get("content-type") ?? "";
      let markdown = "";
      let title = "";

      if (contentType.includes("application/json")) {
        const body = await request.json().catch(() => ({})) as Record<string, unknown>;
        markdown = typeof body.markdown === "string" ? body.markdown : "";
        title = typeof body.title === "string" ? body.title : "";
      } else {
        // text/plain or text/markdown — body IS the markdown
        markdown = await request.text();
      }

      if (!title) {
        // Extract title from first heading
        const headingMatch = markdown.match(/^#\s+(.+)$/m);
        title = headingMatch ? headingMatch[1].trim() : "Untitled";
      }

      const slug = generateSlug();
      const doId = env.DOCUMENT_SESSION.idFromName(slug).toString();
      await env.CATALOG_DB.prepare(
        "INSERT INTO documents (id, slug, title, do_id) VALUES (?, ?, ?, ?)",
      )
        .bind(doId, slug, title, doId)
        .run();

      // Write the markdown content to the DO
      if (markdown) {
        const id = env.DOCUMENT_SESSION.idFromName(slug);
        const stub = env.DOCUMENT_SESSION.get(id);
        await stub.fetch(new Request(
          new URL(`/api/agent/${slug}/rewrite`, url.origin),
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ content: markdown, force: true }),
          },
        ));
      }

      const shareUrl = `${url.origin}/d/${slug}`;
      return Response.json(
        { success: true, slug, url: `/d/${slug}`, shareUrl, title },
        { status: 201 },
      );
    }

    if (path === "/api/metrics/collab-reconnect" && request.method === "POST") {
      return new Response(null, { status: 204 });
    }

    // Agent bridge routes — delegate to DO by slug
    // Matches /api/agent/:slug/* (state, edit, marks, events, etc.)
    const agentMatch = path.match(/^\/api\/agent\/([^/]+)(\/.*)?$/);
    if (agentMatch) {
      const slug = agentMatch[1];
      return routeToDocumentSession(request, env, slug);
    }

    // Document API routes — delegate to Durable Object by slug
    // Matches both /documents/:slug/... and /api/documents/:slug/...
    const documentMatch = path.match(/^(?:\/api)?\/documents\/([^/]+)(\/.*)?$/);
    if (documentMatch) {
      const slug = documentMatch[1];
      return routeToDocumentSession(request, env, slug);
    }

    // WebSocket upgrade — route to DO
    // Supports both /ws/:slug (path-based, used by HocuspocusProvider) and
    // /ws?slug=... (query-based, legacy)
    const wsMatch = path.match(/^\/ws\/([^/]+)\/?$/);
    if (wsMatch) {
      return routeToDocumentSession(request, env, decodeURIComponent(wsMatch[1]));
    }
    if (path === "/ws") {
      const slug = url.searchParams.get("slug");
      if (!slug) {
        return new Response("Missing slug parameter", { status: 400 });
      }
      return routeToDocumentSession(request, env, slug);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/** Forward a request to the Durable Object instance for the given document slug. */
async function routeToDocumentSession(
  request: Request,
  env: Env,
  slug: string,
): Promise<Response> {
  const id = env.DOCUMENT_SESSION.idFromName(slug);
  const stub = env.DOCUMENT_SESSION.get(id);
  return stub.fetch(request);
}

