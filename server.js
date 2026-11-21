'use strict';
/**
 * Letterboxd Lists → Stremio addon
 * Sem dependências: só precisa de Node.js 18+ (usa o fetch nativo).
 *
 * Cada lista do Letterboxd configurada aparece no Stremio como um catálogo
 * próprio (a "tag"), com os filmes pela ordem da lista.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 7000;
const PAGE_SIZE = 100;                                  // itens por pedido do Stremio
const LIST_TTL_MS = (Number(process.env.LIST_TTL_HOURS) || 6) * 3600e3;
const MAX_LIST_PAGES = Number(process.env.MAX_LIST_PAGES) || 30; // ~100 filmes/página no Letterboxd
const CONCURRENCY = Number(process.env.CONCURRENCY) || 6;
const CACHE_FILE = process.env.CACHE_FILE || path.join(__dirname, 'imdb-cache.json');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ---------- cache ----------
const listCache = new Map();   // url -> { title, items:[{slug,name}], fetchedAt, resolved:[], cursor }
const imdbCache = new Map();   // slug -> 'tt123' | null
try {
  const saved = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  for (const [k, v] of Object.entries(saved)) imdbCache.set(k, v);
} catch { /* sem cache ainda */ }
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(CACHE_FILE, JSON.stringify(Object.fromEntries(imdbCache)), () => {});
  }, 5000);
}

// ---------- config (vai codificada no URL do addon) ----------
function encodeConfig(cfg) {
  return Buffer.from(JSON.stringify(cfg), 'utf8').toString('base64url');
}
function decodeConfig(str) {
  try {
    const cfg = JSON.parse(Buffer.from(str, 'base64url').toString('utf8'));
    if (!cfg || !Array.isArray(cfg.lists)) return null;
    cfg.lists = cfg.lists
      .filter(l => l && typeof l.url === 'string')
      .slice(0, 20)
      .map(l => ({ url: l.url.trim(), name: typeof l.name === 'string' ? l.name.trim().slice(0, 80) : '' }));
    return cfg.lists.length ? cfg : null;
  } catch { return null; }
}

// ---------- scraping do Letterboxd ----------
function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

async function getHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'en' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  return { html: await res.text(), finalUrl: res.url || url };
}

/** Aceita links de listas, watchlists e encurtados boxd.it; devolve o URL base canónico. */
async function normalizeListUrl(input) {
  let u = input.trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  let parsed = new URL(u);
  if (/(^|\.)boxd\.it$/i.test(parsed.hostname)) {
    const { finalUrl } = await getHtml(parsed.href);
    parsed = new URL(finalUrl);
  }
  if (!/(^|\.)letterboxd\.com$/i.test(parsed.hostname)) throw new Error('Não é um link do Letterboxd: ' + input);
  const seg = parsed.pathname.split('/').filter(Boolean);
  if (seg[1] === 'list' && seg[2]) return `https://letterboxd.com/${seg[0]}/list/${seg[2]}/`;
  if (seg[1] === 'watchlist') return `https://letterboxd.com/${seg[0]}/watchlist/`;
  if (seg[1] === 'films') return `https://letterboxd.com/${seg[0]}/films/`;
  throw new Error('Formato de link não suportado: ' + input);
}

/** Extrai os filmes de uma página de lista, pela ordem em que aparecem. */
function parseListPage(html) {
  const items = [];
  const seen = new Set();
  // Cada poster é um elemento com atributos data-*; o Letterboxd já usou vários nomes ao longo do tempo.
  const tagRe = /<(?:div|li)\b[^>]*\bdata-(?:film-slug|item-slug|target-link|film-link|item-link)="[^"]*"[^>]*>/gi;
  let m;
  while ((m = tagRe.exec(html))) {
    const tag = m[0];
    const attr = name => { const r = tag.match(new RegExp(`\\bdata-${name}="([^"]*)"`, 'i')); return r ? decodeEntities(r[1]) : null; };
    let slug = attr('film-slug') || attr('item-slug');
    if (!slug) {
      const link = attr('target-link') || attr('film-link') || attr('item-link') || '';
      const lm = link.match(/\/film\/([^/]+)\//);
      slug = lm && lm[1];
    }
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const name = attr('item-name') || attr('film-name') || attr('item-full-display-name') || null;
    items.push({ slug, name });
  }
  const ogTitle = html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i);
  const titleTag = html.match(/<title>([^<]*)<\/title>/i);
  let title = ogTitle ? ogTitle[1] : (titleTag ? titleTag[1] : '');
  title = decodeEntities(title).replace(/\s*[•|·-]\s*Letterboxd\s*$/i, '').trim();
  const hasNext = /class="next"[^>]*href="[^"]*\/page\/\d+\/?"|href="[^"]*\/page\/\d+\/?"[^>]*class="next"/i.test(html);
  return { items, title, hasNext };
}

async function loadList(rawUrl) {
  const cached = listCache.get(rawUrl);
  if (cached && Date.now() - cached.fetchedAt < LIST_TTL_MS) return cached;
  const base = await normalizeListUrl(rawUrl);
  const all = []; const seen = new Set();
  let title = '';
  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    const { html } = await getHtml(page === 1 ? base : `${base}page/${page}/`);
    const parsed = parseListPage(html);
    if (page === 1) title = parsed.title;
    for (const it of parsed.items) if (!seen.has(it.slug)) { seen.add(it.slug); all.push(it); }
    if (!parsed.hasNext || parsed.items.length === 0) break;
  }
  const entry = { title, items: all, fetchedAt: Date.now(), resolved: [], cursor: 0 };
  listCache.set(rawUrl, entry);
  return entry;
}

/** Vai à página do filme no Letterboxd buscar o ID do IMDb (é o que o Stremio usa). */
async function imdbForSlug(slug) {
  if (imdbCache.has(slug)) return imdbCache.get(slug);
  let id = null;
  try {
    const { html } = await getHtml(`https://letterboxd.com/film/${slug}/`);
    const m = html.match(/imdb\.com\/title\/(tt\d+)/i);
    id = m ? m[1] : null;
    imdbCache.set(slug, id);   // só guarda em cache respostas válidas (inclui "não tem IMDb")
    scheduleSave();
  } catch (e) {
    console.warn('Falhou', slug, e.message);
  }
  return id;
}

async function mapLimit(arr, limit, fn) {
  const out = new Array(arr.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, arr.length) }, async () => {
    while (i < arr.length) { const idx = i++; out[idx] = await fn(arr[idx], idx); }
  }));
  return out;
}

/** Resolve IDs só até onde o Stremio precisa (paginação de 100 em 100). */
async function getCatalogSlice(rawUrl, skip) {
  const list = await loadList(rawUrl);
  const need = skip + PAGE_SIZE;
  while (list.resolved.length < need && list.cursor < list.items.length) {
    const batch = list.items.slice(list.cursor, list.cursor + Math.max(CONCURRENCY * 4, need - list.resolved.length));
    list.cursor += batch.length;
    const ids = await mapLimit(batch, CONCURRENCY, it => imdbForSlug(it.slug));
    batch.forEach((it, k) => {
      if (ids[k]) list.resolved.push({
        id: ids[k],
        type: 'movie',
        name: it.name || it.slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        poster: `https://images.metahub.space/poster/medium/${ids[k]}/img`,
        posterShape: 'poster',
      });
    });
  }
  return list.resolved.slice(skip, skip + PAGE_SIZE);
}

function prettySlug(url) {
  const seg = url.replace(/^https?:\/\//, '').split('/').filter(Boolean);
  const s = seg[seg.indexOf('list') + 1] || seg[seg.length - 1] || 'Lista';
  return s.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ---------- manifest ----------
async function buildManifest(cfg) {
  const catalogs = [];
  if (cfg) {
    await mapLimit(cfg.lists, 3, async (l, i) => {
      let name = l.name;
      if (!name) {
        try { name = (await loadList(l.url)).title; } catch { /* usa fallback */ }
      }
      catalogs[i] = {
        type: 'movie',
        id: `letterboxd-${i}`,
        name: name || prettySlug(l.url),
        extra: [{ name: 'skip', isRequired: false }],
      };
    });
  }
  return {
    id: 'community.letterboxd.lists',
    version: '1.0.0',
    name: 'Letterboxd Lists',
    description: 'Mostra listas do Letterboxd como catálogos no Stremio.',
    logo: 'https://a.ltrbxd.com/logos/letterboxd-decal-dots-pos-rgb-500px.png',
    resources: ['catalog'],
    types: ['movie'],
    idPrefixes: ['tt'],
    catalogs,
    behaviorHints: { configurable: true, configurationRequired: !cfg },
  };
}

// ---------- página de configuração ----------
function configurePage(prefill) {
  const lines = prefill ? prefill.lists.map(l => l.name ? `${l.url} | ${l.name}` : l.url).join('\n') : '';
  return `<!doctype html><html lang="pt"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Letterboxd Lists · Stremio</title>
<style>
 body{font-family:system-ui,sans-serif;background:#14181c;color:#def;max-width:640px;margin:40px auto;padding:0 16px}
 h1{color:#fff;font-size:1.5rem} p,li{color:#9ab;line-height:1.5}
 textarea{width:100%;height:160px;background:#1f252b;color:#fff;border:1px solid #456;border-radius:6px;padding:10px;font:14px monospace;box-sizing:border-box}
 button,a.btn{display:inline-block;margin:12px 8px 0 0;padding:10px 18px;border:0;border-radius:6px;background:#00c030;color:#fff;font-weight:600;text-decoration:none;cursor:pointer;font-size:15px}
 button.sec{background:#445566} code{background:#1f252b;padding:2px 5px;border-radius:4px;word-break:break-all}
 #out{margin-top:16px;display:none}
</style></head><body>
<h1>🎬 Letterboxd Lists → Stremio</h1>
<p>Cola um link de lista do Letterboxd por linha. Opcionalmente, põe <code>| Nome</code> no fim para escolher o nome do catálogo (a "tag") no Stremio.</p>
<textarea id="lists" placeholder="https://letterboxd.com/utilizador/list/nome-da-lista/ | Os meus favoritos
https://letterboxd.com/utilizador/watchlist/
https://boxd.it/abcd">${lines.replace(/</g, '&lt;')}</textarea>
<button onclick="gen()">Gerar link</button>
<div id="out">
 <a class="btn" id="install">Instalar no Stremio</a>
 <button class="sec" onclick="navigator.clipboard.writeText(document.getElementById('url').textContent)">Copiar URL</button>
 <p>Ou cola isto em Stremio → Addons → caixa de pesquisa:<br><code id="url"></code></p>
</div>
<script>
function b64url(s){return btoa(unescape(encodeURIComponent(s))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')}
function gen(){
  const lists=document.getElementById('lists').value.split('\\n').map(l=>l.trim()).filter(Boolean).map(l=>{
    const [url,...rest]=l.split('|'); return {url:url.trim(),name:rest.join('|').trim()};
  });
  if(!lists.length){alert('Cola pelo menos um link.');return;}
  const cfg=b64url(JSON.stringify({lists}));
  const https=location.origin+'/'+cfg+'/manifest.json';
  document.getElementById('url').textContent=https;
  document.getElementById('install').href=https.replace(/^https?:/,'stremio:');
  document.getElementById('out').style.display='block';
}
</script></body></html>`;
}

// ---------- servidor HTTP ----------
function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(code, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    ...extra,
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, '');
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const parts = pathname.split('/').filter(Boolean);

  // Rotas sem config
  if (parts.length === 0) return send(res, 302, '', 'text/plain', { Location: '/configure' });
  if (parts[0] === 'configure') return send(res, 200, configurePage(null), 'text/html; charset=utf-8');
  if (parts[0] === 'manifest.json') return send(res, 200, await buildManifest(null));
  if (parts[0] === 'health') return send(res, 200, { ok: true });

  // Rotas com config: /:config/...
  const cfg = decodeConfig(parts[0]);
  if (!cfg) return send(res, 400, { error: 'Configuração inválida' });
  const rest = parts.slice(1);

  if (rest[0] === 'configure') return send(res, 200, configurePage(cfg), 'text/html; charset=utf-8');
  if (rest[0] === 'manifest.json') return send(res, 200, await buildManifest(cfg), undefined, { 'Cache-Control': 'max-age=3600' });

  // /:config/catalog/movie/letterboxd-0.json  ou  /:config/catalog/movie/letterboxd-0/skip=100.json
  if (rest[0] === 'catalog' && rest[1] === 'movie' && rest[2]) {
    const id = rest[2].replace(/\.json$/, '');
    const extra = Object.fromEntries(new URLSearchParams((rest[3] || '').replace(/\.json$/, '')));
    const idx = Number((id.match(/^letterboxd-(\d+)$/) || [])[1]);
    const list = cfg.lists[idx];
    if (!list) return send(res, 404, { metas: [] });
    const skip = Math.max(0, parseInt(extra.skip, 10) || 0);
    try {
      const metas = await getCatalogSlice(list.url, skip);
      return send(res, 200, { metas, cacheMaxAge: 3600, staleRevalidate: 6 * 3600 }, undefined, { 'Cache-Control': 'max-age=3600' });
    } catch (e) {
      console.error('Erro no catálogo', list.url, e.message);
      return send(res, 200, { metas: [] });
    }
  }
  return send(res, 404, { error: 'not found' });
}

function createServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch(e => { console.error(e); send(res, 500, { error: 'erro interno' }); });
  });
}

module.exports = { createServer, parseListPage, encodeConfig, decodeConfig, normalizeListUrl };

if (require.main === module) {
  createServer().listen(PORT, () => {
    console.log(`Addon a correr em http://localhost:${PORT}/configure`);
  });
}
