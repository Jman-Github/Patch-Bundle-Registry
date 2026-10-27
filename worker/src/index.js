import { browseApps } from "./d1-apps.js";
import site from "../../config/site.json" with { type: "json" };
import { D1Catalog } from "./d1-catalog.js";
import { Catalog, CatalogError, bundleImages, canonicalBundleType, catalogOrigins, compareReleaseDates, normalizeSource, pagination, selectRows } from "../../shared/catalog.js";
import { filterApps } from "../../shared/apps.js";
import { latestReleaseIds } from "../../shared/site.js";
import { runGraphQL, withPostgresLocale } from "./graphql.js";
import { openapi } from "./openapi.js";
import { liveJobs, mergeJobs } from "./jobs.js";
import { gitHosts } from "../../shared/hosts.js";
export { RefreshStatus } from "./jobs.js";
export { CatalogSubscriptions } from "./subscriptions.js";

const MAX_RESPONSE = 2 * 1024 * 1024;
async function limitedText(response, maximum) {
  if (+response.headers.get("content-length") > maximum)
    throw new CatalogError("Payload exceeds size limit", 413);
  const reader = response.body?.getReader();
  if (!reader) return "";
  let length = 0;
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maximum) throw new CatalogError("Payload exceeds size limit", 413);
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}
function corsHeaders(request, env) {
  const allowed = (env.CORS_ORIGINS ?? site.website).split(",").map(s => s.trim());
  const origin = request.headers.get("Origin");
  const headers = { "Vary": "Origin", "Access-Control-Expose-Headers": "ETag, X-Catalog-Generation" };
  if (origin && allowed.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}
function matchesEtag(request, etag) {
  if (!["GET", "HEAD"].includes(request.method)) return false;
  const condition = request.headers.get("If-None-Match");
  if (!condition || !etag) return false;
  if (condition.trim() === "*") return true;
  // If-None-Match uses weak comparison; proxies can weaken tags on compression.
  const opaque = tag => tag.replace(/^W\//, "");
  const tags = condition.match(/(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"/g) ?? [];
  return tags.some(tag => opaque(tag) === opaque(etag));
}
async function jsonResponse(request, env, data, status, generation, cacheable = true) {
  let body = JSON.stringify(data);
  if (new TextEncoder().encode(body).length > MAX_RESPONSE) {
    status = 422; body = JSON.stringify({ error: "Response too large; reduce the query limit", code: "response_too_large" });
    cacheable = false;
  }
  const headers = { ...corsHeaders(request, env), "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": cacheable && status === 200 ? "public, max-age=60" : "no-store" };
  if (generation) headers["X-Catalog-Generation"] = generation;
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode((generation ?? "") + body)))]
    .map(n => n.toString(16).padStart(2, "0")).join("");
  headers.ETag = '"' + hash + '"';
  if (status === 200 && matchesEtag(request, headers.ETag))
    return new Response(null, { status: 304, headers });
  return new Response(body, { status, headers });
}
function manifestResponse(request, env, manifest) {
  // This immutable generation's file index is a static document, not a query page.
  const headers = { ...corsHeaders(request, env), "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff", "Cache-Control": "public, max-age=60",
    "X-Catalog-Generation": manifest.generation, "ETag": '"manifest-' + manifest.generation + '"' };
  if (matchesEtag(request, headers.ETag))
    return new Response(null, { status: 304, headers });
  return new Response(JSON.stringify(manifest), { headers });
}
function cacheFetcher(env, context) {
  let cacheReads = 0;
  return async url => {
    // Cache API calls share the Free plan's 50-call quota with fetch.
    // At most 37 fetches plus five match/put pairs = 47 calls on a cold cache.
    const cache = /\/manifest\.json$/.test(String(url)) ? null :
      cacheReads++ < 5 ? globalThis.caches?.default : null;
    const key = new Request(url);
    const cached = cache && await cache.match(key);
    if (cached) return cached;
    const upstream = await (env.FETCH?.fetch?.bind(env.FETCH) ?? env.FETCH ?? fetch)(url, {
      redirect: "manual", signal: AbortSignal.timeout(10000), cache: "no-store"
    });
    if (!upstream.ok) return upstream;
    const immutable = /\/snapshots\/[a-f0-9]{24}\//.test(String(url));
    const text = await limitedText(upstream, 12 * 1024 * 1024);
    const response = new Response(text, { headers: {
      "Content-Type": "application/json",
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=60"
    } });
    if (cache && context?.waitUntil) context.waitUntil(cache.put(key, response.clone()));
    return response;
  };
}
function channel(value) {
  value = value.trim().toLowerCase();
  const aliases = { any: "latest", latest: "latest", stable: "stable", dev: "dev", prerelease: "dev" };
  if (!Object.hasOwn(aliases, value)) throw new CatalogError("channel must be any, latest, stable, dev, or prerelease");
  return aliases[value];
}
function dto(bundle) {
  return { created_at: String(bundle.created_at ?? "").split("Z")[0], description: bundle.description,
    version: bundle.version, download_url: bundle.download_url,
    signature_download_url: bundle.signature_download_url === "N/A" ? "" : (bundle.signature_download_url ?? ""),
    bundle_type: bundle.bundle_type, ...bundleImages(bundle),
    source: { url: bundle.source.url, host: bundle.source.host,
      namespace: bundle.source.namespace, repo: bundle.source.repo },
    file_hash: bundle.file_hash, need_patches_update: bundle.need_patches_update,
    metadata_status: bundle.metadata_status, patcher_runtime: bundle.patcher_runtime };
}
function legacyDto(bundle) {
  return { created_at: String(bundle.created_at ?? "").split("Z")[0],
    description: bundle.description ?? "", version: bundle.version,
    download_url: bundle.download_url, signature_download_url:
      bundle.signature_download_url === "N/A" ? "" : (bundle.signature_download_url ?? ""),
    ...bundleImages(bundle) };
}

/** Retrieve the publisher's native index, checking cached identity when available. */
async function fetchReseamIndex(releaseUrl, env) {
  const origin = new URL(releaseUrl);
  let current = origin;
  const signal = AbortSignal.timeout(12000);
  const fetcher = env.RESEAM_RELEASE_FETCH ?? fetch;
  for (let redirects = 0; redirects < 5; redirects++) {
    const response = await fetcher(current.href, { redirect: "manual", signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("Location");
    let next;
    try { next = new URL(location, current); }
    catch { throw new CatalogError("Reseam release asset redirect is invalid", 503); }
    // Publishers serve native indexes through these HTTPS object hosts.
    // Never follow arbitrary redirects from a publisher's origin.
    const trustedCdn = (origin.hostname === "github.com" &&
      ["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(next.hostname)) ||
      (origin.hostname === "gitlab.com" && next.hostname === "storage.googleapis.com") ||
      (origin.hostname === "api.reseam.app" && next.hostname === "cdn.reseam.app");
    if (!location || next.protocol !== "https:" || next.username || next.password ||
        next.hash || (next.origin !== origin.origin && (!trustedCdn || next.port)) ||
        next.href === current.href)
      throw new CatalogError("Reseam release asset redirected to an untrusted host", 503);
    current = next;
  }
  throw new CatalogError("Too many Reseam release asset redirects", 503);
}
async function reseamReleaseIndex(bundle, env) {
  const publisher = bundle.reseam_bundle;
  if (bundle.bundle_type !== "Reseam") throw new CatalogError("Source has no matching Reseam bundle",404);
  // A native index remains usable by Reseam Manager even if this catalog's
  // binary inspector does not yet support the publisher's newest engine.
  // When verified identity is available, require the upstream index to match.
  if (publisher && (typeof publisher.name !== "string" ||
      !/^[a-f0-9]{64}$/i.test(publisher.public_key ?? "")))
    throw new CatalogError("Reseam publisher metadata is invalid",503);
  const source = new URL(normalizeSource(bundle.source.url));
  if (source.protocol !== "https:")
    throw new CatalogError("Reseam release source must use HTTPS", 422);
  const tag = String(bundle.version ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._+\-]{0,127}$/.test(tag))
    throw new CatalogError("Unsupported release tag for Reseam native index",422);
  // Official native indexes moved from Git release assets to the Reseam API.
  // Build every URL from the canonical source and tag, never caller-provided URLs.
  const root = source.href.replace(/\/$/, "");
  const releaseUrl = root === "https://git.reseam.app/reseam/patches" ?
    "https://api.reseam.app/patches/" + encodeURIComponent("v" + tag.replace(/^v/, "")) + "/patches.json" :
    root + (gitHosts[source.host] === "gitlab" ?
      "/-/releases/" + encodeURIComponent(tag) + "/downloads/patches.json" :
      "/releases/download/" + encodeURIComponent(tag) + "/patches.json");
  let response;
  try { response = await fetchReseamIndex(releaseUrl, env); }
  catch { throw new CatalogError("Reseam native release index is temporarily unavailable",503); }
  if (response.status === 404) throw new CatalogError("This release has no patches.json asset",404);
  if (!response.ok) throw new CatalogError("Reseam native release index is unavailable",503);
  let document;
  try { document = JSON.parse(await limitedText(response, MAX_RESPONSE)); }
  catch (error) {
    if (error instanceof CatalogError) throw error;
    throw new CatalogError("Reseam release index is invalid",502);
  }
  const releases = document?.releases;
  if (!document || typeof document !== "object" || !document.bundle ||
      !/^[a-f0-9]{64}$/i.test(document.bundle.public_key ?? "") ||
      typeof document.bundle.name !== "string" ||
      (publisher && (document.bundle.public_key.toLowerCase() !== publisher.public_key.toLowerCase() ||
        document.bundle.name !== publisher.name)) || !Array.isArray(releases) ||
      !releases.length || !releases.every(row => row && typeof row.version === "string" &&
        typeof row.download_url === "string" && typeof row.prerelease === "boolean" &&
        typeof row.description === "string" && typeof row.created_at === "string" &&
        (!Object.hasOwn(row, "patches") || Array.isArray(row.patches))) ||
      releases.filter(row => row.version.replace(/^v/, "") === tag.replace(/^v/, "")).length !== 1)
    throw new CatalogError("Reseam release index does not match the verified publisher and version",502);
  return document;
}
function filteredBundles(bundles, params) {
  const q = (params.get("q") ?? "").toLowerCase();
  const source = params.get("source") ?? params.get("source_url");
  const canonical = source?.includes("/") ? normalizeSource(source).toLowerCase() : null;
  const selectedChannel = params.has("channel") ? channel(params.get("channel")) : null;
  return bundles.filter(b =>
    (!q || (b.description + " " + b.version + " " + b.source.url + " " +
      b.source.aliases.join(" ")).toLowerCase().includes(q)) &&
    (!source || b.source_id === source || b.source.aliases.includes(source) ||
      b.source.url.toLowerCase() === canonical) &&
    (!params.has("ecosystem") || b.ecosystem === params.get("ecosystem")) &&
    (!params.has("bundle_type") || b.bundle_type === canonicalBundleType(params.get("bundle_type"))) &&
    (!params.has("version") || b.version === params.get("version")) &&
    (!params.has("package") || b.packages.includes(params.get("package"))) &&
    (!selectedChannel || b.channels.includes(selectedChannel)) &&
    (!params.has("metadata_status") || b.metadata_status === params.get("metadata_status")));
}
function restArgs(params, fields) {
  const args = pagination(Object.fromEntries(params));
  if (params.has("sort")) {
    const sort = params.get("sort");
    if (!fields.includes(sort)) throw new CatalogError("Unsupported sort field");
    const direction = params.get("order") ?? "asc";
    args.order_by = { [sort]: direction };
  }
  return args;
}
function appSummary(app) {
  const { bundles, id, ...summary } = app;
  return summary;
}
async function bundleApplications(catalog, id) {
  // Imports retain their compact read path, including on older snapshots.
  if (!catalog.manifest.files["bundle-apps/" + id + ".json"]) return {};
  const apps = await catalog.bundleApps(id);
  return { apps: apps.slice(0, 100), app_count: apps.length,
    apps_url: "/bundles/" + id + "/apps" };
}
async function selectedApps(catalog, params) {
  let bundles = await catalog.bundles({ compact: true });
  const latest = latestReleaseIds(bundles);
  const release = params.get("release") ?? "all";
  if (!["all", "latest", "release", "prerelease"].includes(release))
    throw new CatalogError("release must be all, latest, release, or prerelease");
  const bundleParams = new URLSearchParams([...params].filter(([key]) =>
    ["source", "source_url", "ecosystem", "bundle_type", "version", "channel", "metadata_status"].includes(key)));
  bundles = filteredBundles(bundles, bundleParams).filter(bundle =>
    (params.get("include_unverified") === "true" || bundle.metadata_status === "verified") &&
    (release === "all" || (release === "latest" ? latest.has(bundle.id) :
      bundle.is_prerelease === (release === "prerelease"))));
  const apps = filterApps(await catalog.apps(), bundles, {
    q: params.get("q") ?? "", packageQuery: params.get("package") ?? "",
    appVersion: params.get("app_version") ?? "", exactAppVersion: true
  });
  return { apps, bundles };
}
async function rest(catalog, url, env = {}) {
  const originalPath = url.pathname.replace(/\/$/, "");
  const path = originalPath.replace(/^\/api\/v1(?=\/(?:sources|bundles|releases|packages|patches|availability|apps)(?:\/|$))/, "");
  const params = url.searchParams;
  if (catalog.rows && path === "/catalog/bundles") {
    if (params.get("generation") !== catalog.manifest.generation)
      throw new CatalogError("Catalog changed; restart pagination",409);
    const where = {source:{enabled:{_eq:true}}};
    if (params.has("source")) where.source.id = {_in:await catalog.sourceIds(params.get("source"))};
    else where.is_latest = {_eq:true};
    const args = {limit:Number(params.get("limit") ?? 100),offset:Number(params.get("offset") ?? 0),where};
    const data = await catalog.restRows(await catalog.rows("bundle",args));
    // Browsing needs summaries; changelogs and full source inventories are loaded on demand.
    for (const row of data) {
      row.description = row.description ? "Available" : "";
      if (row.source) {
        const {bundles,...source} = row.source;
        row.source = source;
      }
    }
    const total = await catalog.count("bundle",{where});
    return {data,total,generation:catalog.manifest.generation};
  }
  if (catalog.rows && path === "/catalog/patches") {
    if (params.get("generation") !== catalog.manifest.generation)
      throw new CatalogError("Catalog changed; restart pagination",409);
    if (!params.has("bundle_id")) throw new CatalogError("bundle_id is required");
    const {limit} = pagination({limit:params.get("limit") ?? 100});
    const offset = Number(params.get("page_cursor") ?? 0);
    const compact = params.get("compact") === "true";
    const page = await catalog.patchRows({bundle_id:params.get("bundle_id"),package:params.get("package"),
      include_unverified:params.get("include_unverified")==="true",page_cursor:offset,limit,compact});
    if (compact)
      page.rows = page.rows.map(({bundle,patch_packages,...patch})=>patch);
    // Keep complete patch records, but shorten pages to fit the response budget.
    // Preserve the offset of the first omitted row so no patches are skipped.
    const original = page.rows;
    const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
    let size = bytes({...page,rows:[],next_cursor:offset+original.length}), count = 0;
    for (const row of original) {
      const added = bytes(row) + (count ? 1 : 0);
      if (count && size + added > MAX_RESPONSE) break;
      size += added;
      count++;
      if (size > MAX_RESPONSE) break; // A single oversized patch still returns a clear 422.
    }
    if (count < original.length) {
      page.rows = original.slice(0,count);
      page.next_cursor = offset + count;
    }
    return page;
  }
  const direct = path.replace(/^\/api\/v1/,"").match(/^\/(bundles|sources)\/([a-f0-9]+)$/);
  if (catalog.rows && direct) {
    const kind = direct[1] === "bundles" ? "bundle" : "source";
    const row = (await catalog.rows(kind,{where:{catalog_id:{_eq:direct[2]}},limit:1}))[0];
    if (!row) throw new CatalogError("Record not found",404);
    const result = await catalog.restRow(row);
    return kind === "bundle" ? {...result,...(await bundleApplications(catalog,row.catalog_id))} : result;
  }
  const historicalKind = {"/history/bundles":"bundle","/history/patches":"patch",
    "/history/apps":"app", "/history/packages":"package","/history/patch-packages":"patch_package"}[path];
  if (catalog.rows && historicalKind) {
    const where = {};
    for (const field of ["source_id","bundle_id","name","version","patcher_runtime","metadata_status","catalog_id"])
      if (params.has(field)) where[field] = {_eq:params.get(field)};
    for (const field of ["package_fk","patch_fk","bundle_fk","source_fk"]) {
      if (!params.has(field)) continue;
      const raw = params.get(field)?.trim() ?? "";
      const value = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value))
        throw new CatalogError("Invalid " + field + " filter");
      where[field] = {_eq:value};
    }
    const args = {where,limit:Number(params.get("limit") ?? 25),offset:Number(params.get("offset") ?? 0),
      include_archived:true,generation:params.get("generation")};
    return {generation:catalog.manifest.generation,data:await Promise.all((await catalog.rows(historicalKind,args)).map(row=>catalog.restRow(row))),
      total:await catalog.count(historicalKind,{where,include_archived:true}),limit:args.limit,offset:args.offset};
  }
  if (catalog.history && path.startsWith("/history/")) {
    const documentMatch = path.match(/^\/history\/releases\/([a-f0-9]{24})\/document$/);
    if (documentMatch) return catalog.historyDocument(documentMatch[1],Object.fromEntries(params));
    const match = path.match(/^\/history\/releases(?:\/([a-f0-9]{24}))?$/);
    if (match) {
      const args = Object.fromEntries(params);
      if (match[1]) args.id = match[1];
      const result = await catalog.history(args);
      if (match[1] && !result.data.length) throw new CatalogError("Release not found",404);
      return match[1] ? result.data[0] : result;
    }
    if (path === "/history/sources") {
      const args = {limit:Number(params.get("limit") ?? 25),offset:Number(params.get("offset") ?? 0),generation:params.get("generation")};
      const rows = await catalog.rows("history_source",args);
      return {data:await Promise.all(rows.map(row=>catalog.restRow(row))),total:await catalog.count("history_source"),...args,generation:catalog.manifest.generation};
    }
  }
  if (catalog.rows && ["/sources","/bundles","/releases"].includes(path)) {
    const kind = path === "/sources" ? "source" : "bundle";
    const where = {};
    for (const field of ["source_id","version","ecosystem","bundle_type","metadata_status"])
      if (params.has(field)) where[field] = {_eq:field === "bundle_type" ? canonicalBundleType(params.get(field)) : params.get(field)};
    if (params.has("source") || params.has("source_url")) {
      const source = params.get("source") ?? params.get("source_url");
      const ids = await catalog.sourceIds(source);
      if (kind === "source") where.id = {_in:ids};
      else where.source_fk = {_in:ids};
    }

    const simple = !["q","package","channel","sort"].some(key=>params.has(key));
    if (simple) {
      const args = {...restArgs(params,["id"]),where,order_by:{catalog_id:"asc"}};
      if (kind === "bundle") args.where = {...where,source:{...(where.source ?? {}),enabled:{_eq:true}}};
      const data = await Promise.all((await catalog.rows(kind,args)).map(row=>catalog.restRow(row)));
      return {data,total:await catalog.count(kind,{where:args.where}),limit:args.limit,offset:args.offset};
    }
    const args={...restArgs(params,kind==="bundle"?["id","version","created_at","patch_count"]:["id","url","repo"]),where};
    return catalog.browse(kind,params,args,row=>kind==="bundle" ? filteredBundles([row],params).length>0 :
      !(params.get("q")??"") || (row.url+" "+row.aliases.join(" ")).toLowerCase().includes(params.get("q").toLowerCase()));
  }
  if (path === "/health") return { ok: true, generation: catalog.manifest.generation,
                                  counts: catalog.manifest.counts };
  if (path === "/api/v3/bundle" || path === "/api/reseam/bundle" || path === "/api/reseam/patches.json") {
    const sourceUrl = params.get("source_url");
    const version = params.get("version")?.trim();
    if (!sourceUrl || !version) throw new CatalogError("source_url and version are required");
    const source = normalizeSource(sourceUrl).toLowerCase();
    const latest = version.toLowerCase() === "latest";
    const mode = params.get("channel")?.trim() || "any";
    if (latest && !params.get("channel")?.trim())
      throw new CatalogError("channel is required for version=latest");
    const selectedChannel = channel(mode);
    const bundles = (await catalog.importBundles(source,{version,latest,mode})).filter(b => b.source.url.toLowerCase() === source &&
      (latest ? b.is_latest : b.version === version) &&
      (mode === "any" || selectedChannel === "latest" ||
        (selectedChannel === "stable" ? !b.is_prerelease : b.is_prerelease)));
    bundles.sort((a, b) =>
      compareReleaseDates(a, b) ||
      Number(b.channels.length > 0) - Number(a.channels.length > 0));
    if (!bundles.length) throw new CatalogError("No cached bundle matches source and version", 404);
    const bundle = { ...bundles[0], ...(await catalog.file("bundles/" + bundles[0].id + ".json")),
                     source: bundles[0].source };
    if (path === "/api/reseam/patches.json") return reseamReleaseIndex(bundle, env);
    if (path === "/api/reseam/bundle") {
      if (bundle.bundle_type !== "Reseam") throw new CatalogError("Source has no matching Reseam bundle", 404);
      const publisher = bundle.reseam_bundle;
      if (bundle.metadata_status !== "verified" || !publisher ||
          !["name", "author", "description", "public_key"].every(key => typeof publisher[key] === "string") ||
          !/^[a-f0-9]{64}$/i.test(publisher.public_key))
        throw new CatalogError("Reseam signing metadata is not available yet", 503);
      return {
        ...bundleImages(bundle),
        bundle: { ...publisher, homepage: bundle.source.url },
        releases: [{ version: bundle.version, created_at: bundle.created_at,
          description: bundle.description ?? "", download_url: bundle.download_url,
          prerelease: bundle.is_prerelease }]
      };
    }
    return { ...dto(bundle), ...(await bundleApplications(catalog, bundle.id)) };
  }
  const numeric = path.match(/^\/api\/v1\/bundle\/([0-9]+)$/);
  if (numeric) {
    const bundle = catalog.rows ? await catalog.rows("bundle",{where:{id:{_eq:Number(numeric[1])}},limit:1})
      .then(rows=>rows[0] && catalog.restRow(rows[0])) :
      (await catalog.bundles()).find(b => b.legacy_id === Number(numeric[1]));
    if (!bundle) throw new CatalogError("Bundle not found", 404);
    return legacyDto({ ...bundle, ...(await catalog.file("bundles/" + bundle.id + ".json")) });
  }
  const compatibility = path.match(/^\/api\/v[12]\/bundle\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (compatibility) {
    const owner = decodeURIComponent(compatibility[1]), repo = decodeURIComponent(compatibility[2]);
    const version = decodeURIComponent(compatibility[3]);
    const v2 = path.startsWith("/api/v2/");
    if (v2 && version !== "latest") throw new CatalogError("Endpoint not found", 404);
    if (v2 && !params.has("channel")) throw new CatalogError("channel is required");
    const mode = v2 ? channel(params.get("channel").trim().toLowerCase()) :
      params.get("prerelease") === "true" ? "dev" : "stable";
    // Reference v1/v2 lookups join repository metadata, regardless of host.
    // In particular, renamed repositories use their recorded current name.
    const bundles = (catalog.legacyBundles ? await catalog.legacyBundles(owner,repo,version,mode) : await catalog.bundles()).filter(bundle => {
      const metadata = bundle.source.source_metadatum ?? {};
      return (metadata.owner_name ?? bundle.source.namespace) === owner &&
        (metadata.repo_name ?? bundle.source.repo) === repo &&
        (version === "latest" ? bundle.is_latest &&
          (mode === "latest" || bundle.is_prerelease === (mode === "dev")) :
          bundle.version === version);
    });
    if (version === "latest") bundles.sort(compareReleaseDates);
    if (!bundles.length) throw new CatalogError("Bundle not found", 404);
    const bundle = bundles[0];
    return legacyDto({ ...bundle, ...(await catalog.file("bundles/" + bundle.id + ".json")) });
  }
  const normalized = path.replace(/^\/api\/v1/, "");
  const appMatch = normalized.match(/^\/apps\/([^/]+)(?:\/(bundles|patches))?$/);
  const bundleAppsMatch = normalized.match(/^\/bundles\/([a-f0-9]{24})\/apps$/);
  if (bundleAppsMatch) {
    const bundle = catalog.rows ? await catalog.rows("bundle",{where:{catalog_id:{_eq:bundleAppsMatch[1]}},limit:1}).then(rows=>rows[0] && catalog.restRow(rows[0])) :
      (await catalog.bundles({ compact: true })).find(bundle => bundle.id === bundleAppsMatch[1]);
    if (!bundle) throw new CatalogError("Bundle not found", 404);
    const q = (params.get("q") ?? "").toLowerCase();
    const apps = (await catalog.bundleApps(bundle.id)).filter(app =>
      (!q || (app.app_name + " " + app.package_name).toLowerCase().includes(q)) &&
      (!params.has("app_version") || app.unrestricted || app.versions.includes(params.get("app_version"))));
    return selectRows(apps.map(app => ({ ...app, metadata_status: bundle.metadata_status })),
      restArgs(params, ["package_name", "app_name", "patch_count"]));
  }
  if (normalized === "/apps" || (appMatch && appMatch[2] !== "patches")) {
    if (catalog.rows) return browseApps(catalog,params,
      restArgs(params,appMatch?.[2] === "bundles" ? ["id","version","created_at","patch_count"] :
        ["package_name","app_name","bundle_count","patch_count"]),
      appMatch ? decodeURIComponent(appMatch[1]) : null,appMatch?.[2] === "bundles");
    const { apps, bundles } = await selectedApps(catalog, params);
    if (!appMatch)
      return selectRows(apps.map(appSummary), restArgs(params, ["package_name", "app_name", "bundle_count", "patch_count"]));
    const app = apps.find(app => app.package_name === decodeURIComponent(appMatch[1]));
    if (!app) throw new CatalogError("App not found", 404);
    if (appMatch[2] === "bundles") {
      const references = new Map(app.bundles.map(reference => [reference.bundle_id, reference]));
      const result = selectRows(bundles.filter(bundle => references.has(bundle.id)).map(bundle => ({
        ...bundle, app_compatibility: references.get(bundle.id)
      })), restArgs(params, ["id", "version", "created_at", "patch_count"]));
      result.data = await Promise.all(result.data.map(async bundle => ({
        ...bundle, ...(await catalog.file("bundles/" + bundle.id + ".json"))
      })));
      return result;
    }
    return { ...appSummary(app), bundles_url: "/apps/" + encodeURIComponent(app.package_name) + "/bundles",
      patches_url: "/apps/" + encodeURIComponent(app.package_name) + "/patches" };
  }
  if (appMatch?.[2] === "patches") params.set("package", decodeURIComponent(appMatch[1]));
  if (normalized === "/sources") {
    const q = (params.get("q") ?? "").toLowerCase();
    const source = params.get("source_url");
    const rows = (await catalog.sources()).filter(s =>
      (!source || s.url.toLowerCase() === normalizeSource(source).toLowerCase()) &&
      (!q || (s.url + " " + s.aliases.join(" ")).toLowerCase().includes(q)));
    return selectRows(rows, restArgs(params, ["id", "url", "repo"]));
  }
  if (normalized === "/bundles" || normalized === "/releases") {
    const rows = filteredBundles(await catalog.bundles(), params);
    return selectRows(rows, restArgs(params, ["id", "version", "created_at", "patch_count"]));
  }
  if (normalized === "/packages") {
    const q = (params.get("q") ?? "").toLowerCase();
    const rows = (await catalog.file("packages.json")).filter(p => !q || (p.name + " " + (p.app_name ?? "")).toLowerCase().includes(q));
    return selectRows(rows, restArgs(params, ["name"]));
  }
  if (normalized === "/availability") return catalog.file("availability.json");
  const patchesMatch = normalized.match(/^\/bundles\/([a-f0-9]{24})\/patches$/);
  if (normalized === "/patches" || patchesMatch || appMatch?.[2] === "patches") {
    const bundleId = patchesMatch?.[1] ?? params.get("bundle_id");
    if (catalog.patchWindow) {
      if (params.has("bundle_type")) params.set("bundle_type",canonicalBundleType(params.get("bundle_type")));
      const page=await catalog.patchWindow(params,bundleId);
      const selected=selectRows(page.rows,restArgs(params,["id","name"]));
      selected.data=await catalog.decoratePatches(selected.data.map(row=>row.id));
      return {...selected,next_cursor:page.next_cursor,candidate_pages:page.candidate_pages};
    }
    const eligibleBundles = filteredBundles(await catalog.bundles({ compact: Boolean(appMatch) }), new URLSearchParams(
      [...params].filter(([key]) => ["source", "source_url", "ecosystem", "bundle_type", "channel"].includes(key))));
    const result = await catalog.patchRows({ q: params.get("q") ?? "",
      bundle_ids: eligibleBundles.map(b => b.id),
      package: params.get("package"), bundle_id: bundleId,
      page_cursor: params.get("page_cursor") ?? 0,
      include_unverified: params.get("include_unverified") === "true",
      compact_bundles: Boolean(appMatch) });
    let rows = result.rows;
    if (params.has("app_version")) rows = rows.filter(p =>
      p.packages.some(pkg => (!params.has("package") || pkg.name === params.get("package")) &&
        (!pkg.versions.length || pkg.versions.includes(params.get("app_version")))));
    const selected = selectRows(rows, restArgs(params, ["id", "name"]));
    if (appMatch) selected.data = await Promise.all(selected.data.map(async patch => ({
      ...patch, bundle: { ...patch.bundle, ...(await catalog.file("bundles/" + patch.bundle_id + ".json")) }
    })));
    return { ...selected, next_cursor: result.next_cursor, candidate_pages: result.candidate_pages };
  }
  const detail = normalized.match(/^\/(sources|bundles)\/([a-f0-9]+)$/);
  if (detail) {
    const rows = detail[1] === "sources" ? await catalog.sources() : await catalog.bundles({ compact: true });
    const row = rows.find(r => r.id === detail[2]);
    if (!row) throw new CatalogError("Record not found", 404);
    return detail[1] === "bundles" ? {
      ...row, ...(await catalog.file("bundles/" + row.id + ".json")), source: row.source,
      ...(await bundleApplications(catalog, row.id))
    } : row;
  }
  throw new CatalogError("Endpoint not found", 404);
}
async function createCatalog(env, context) {
  if (env.CATALOG_BACKEND === "d1") {
    if (!env.DB || !env.ARCHIVE) throw new CatalogError("D1/R2 bindings are required",503);
    const catalog = await new D1Catalog(env,{cacheDocuments:Boolean(context?.waitUntil)}).initialize();
    catalog.regexLocale = env.POSTGRES_LOCALE ?? site.postgres_locale;
    if (env.REFRESH_STATUS || env.JOBS_FETCH) catalog.liveJobs = () => liveJobs(env);
    return catalog;
  }
  const base = env.DATA_BASE_URL ?? site.website + "/" + site.database_path + "/";
  const parsedBase = new URL(base);
  if (parsedBase.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(parsedBase.hostname))
    throw new CatalogError("Invalid data origin configuration", 503);
  const origins = env.DATA_BASE_URL ? [base] : catalogOrigins(site,base);
  let failure;
  for (const origin of origins) {
    try {
      const catalog = await new Catalog(origin,cacheFetcher(env,context)).initialize();
      catalog.regexLocale = env.POSTGRES_LOCALE ?? site.postgres_locale;
      if (env.REFRESH_STATUS || env.JOBS_FETCH) catalog.liveJobs = () => liveJobs(env);
      return catalog;
    } catch(error) { failure = error; }
  }
  throw failure;
}
export async function executeCatalogQuery(env, context, payload, options = {}) {
  const catalog=await createCatalog({...env,LIVE_SUBSCRIPTION:true},context);
  const result = await runGraphQL(catalog,payload,options);
  if (options.subscription) result.extensions={...result.extensions,registryGeneration:catalog.manifest.generation};
  if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_RESPONSE)
    throw new CatalogError("Response too large; reduce the query limit",422);
  return result;
}
export default {
  async fetch(request, env = {}, context) {
    const url = new URL(request.url);
    let generation;
    try {
      if (url.href.length > 12000) throw new CatalogError("Request URL too long", 414);
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: {
          ...corsHeaders(request, env), "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, If-None-Match", "Access-Control-Max-Age": "86400"
        } });
      }
      const graphql = ["/graphql", "/v1/graphql", "/hasura/v1/graphql"].includes(url.pathname);
      if (graphql && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
        const origin = request.headers.get("Origin");
        const allowed = (env.CORS_ORIGINS ?? site.website).split(",").map(s => s.trim());
        if (origin && !allowed.includes(origin)) throw new CatalogError("Origin not allowed",403);
        if (!env.SUBSCRIPTIONS) throw new CatalogError("Subscriptions unavailable",503);
        // Isolate each connection so alarm work scales with connected clients.
        return env.SUBSCRIPTIONS.get(env.SUBSCRIPTIONS.idFromName("connection-" + crypto.randomUUID())).fetch(request);
      }
      if (!["GET", "POST"].includes(request.method) || (request.method === "POST" && !graphql))
        throw new CatalogError("Read-only endpoint; method not allowed", 405);
      if (url.pathname === "/api.json" || url.pathname === "/openapi.json")
        return jsonResponse(request, env, openapi, 200, undefined);
      if (["/swagger", "/swagger/", "/graphiql", "/graphiql/"].includes(url.pathname)) {
        const page = url.pathname.startsWith("/swagger") ? "/api-docs/" : "/graphiql/";
        return Response.redirect(site.website + page, 302);
      }
      const jobMatch = url.pathname.match(/^\/api\/v1\/refresh\/status\/([^/]+)$/);
      if (url.pathname === "/refresh-jobs" || jobMatch) {
        let rows;
        if (jobMatch && /^[1-9][0-9]{0,15}$/.test(jobMatch[1])) {
          rows = await liveJobs(env,jobMatch[1]);
        } else {
          if (jobMatch && !/^(?:[a-f0-9]{24}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(jobMatch[1]))
            throw new CatalogError("Invalid refresh job ID");
          const catalog = await createCatalog(env,context);
          const recorded = catalog.manifest.files["refresh-jobs.json"] ?
            await catalog.file("refresh-jobs.json") : [];
          if (jobMatch) {
            rows = recorded.filter(row => row.job_id === jobMatch[1]);
            if (rows[0]?.actions_run_id && ["STARTED","PENDING","RUNNING"].includes(rows[0].status)) {
              // Recover phase status after abrupt runner cancellation.
              try {
                rows = mergeJobs(rows,await liveJobs(env,rows[0].actions_run_id))
                  .filter(row => row.job_id === jobMatch[1]);
              } catch { /* Retain the published status during a GitHub outage. */ }
            }
          } else {
            let live = [];
            try { live = await liveJobs(env); }
            catch (error) { if (!recorded.length) throw error; }
            rows = mergeJobs(recorded,live);
          }
          if (jobMatch && !rows.length) throw new CatalogError("Refresh job not found",404);
        }
        rows = mergeJobs(rows,[]);
        const running = jobMatch && ["STARTED","PENDING","RUNNING"].includes(rows[0].status);
        const dto = jobMatch ? {jobId:rows[0].job_id,type:rows[0].job_type,status:rows[0].status,
          startedAt:rows[0].started_at,completedAt:rows[0].completed_at,error:rows[0].error} :
          selectRows(rows,restArgs(url.searchParams,["id","status","started_at","completed_at"]));
        return jsonResponse(request,env,dto,running ? 202 : 200,undefined,false);
      }
      const catalog = await createCatalog(env,context);
      generation = catalog.manifest.generation;
      if (catalog.document && url.pathname.startsWith("/catalog/data/")) {
        if (url.pathname === "/catalog/data/manifest.json")
          return manifestResponse(request,env,catalog.manifest);
        const match = url.pathname.match(/^\/catalog\/data\/snapshots\/([a-f0-9]{24})\/(.+)$/);
        if (!match) throw new CatalogError("Catalog file not found",404);
        let document = catalog.document;
        if (match[1] !== generation) {
          const row = await catalog.db.prepare("SELECT manifest_key FROM catalog_generations WHERE generation=? AND status='ready'").bind(match[1]).first();
          const stored = row && await env.ARCHIVE.get(row.manifest_key);
          if (!stored) throw new CatalogError("Catalog generation unavailable",404);
          document = await stored.json();
        }
        const name = match[2];
        if (!Object.hasOwn(document.manifest.files,name)) throw new CatalogError("Catalog file not found",404);
        const object = await env.ARCHIVE.get("objects/"+document.files[name]);
        if (!object) throw new CatalogError("Catalog object unavailable",503);
        const headers = {...corsHeaders(request,env),"Content-Type":"application/json",
          "Cache-Control":"public,max-age=31536000,immutable","ETag":'"'+document.files[name]+'"',
          "X-Catalog-Generation":match[1],"X-Content-Type-Options":"nosniff"};
        if (matchesEtag(request, headers.ETag))
          return new Response(null,{status:304,headers});
        return new Response(object.body ?? JSON.stringify(await object.json()),{headers});
      }
      // Cache completed GET responses by immutable generation and origin. Publication
      // changes the key immediately; conditional requests reuse the stored ETag.
      const responseCache = request.method === "GET" && context?.waitUntil ? globalThis.caches?.default : null;
      const cacheUrl = new URL(request.url);
      cacheUrl.searchParams.set("__catalog_generation",generation);
      cacheUrl.searchParams.set("__catalog_origin",request.headers.get("Origin") ?? "");
      const responseKey = new Request(cacheUrl);
      const cached = responseCache && await responseCache.match(responseKey);
      if (cached) {
        if (matchesEtag(request, cached.headers.get("ETag")))
          return new Response(null,{status:304,headers:cached.headers});
        return cached;
      }
      let result;
      if (graphql) {
        let payload;
        if (request.method === "POST") {
          if (!request.headers.get("Content-Type")?.includes("application/json"))
            throw new CatalogError("Expected application/json", 415);
          payload = JSON.parse(await limitedText(request, 32768));
        } else payload = { query: url.searchParams.get("query"),
          variables: JSON.parse(url.searchParams.get("variables") ?? "{}"),
          operationName: url.searchParams.get("operationName") ?? undefined };
        result = await runGraphQL(catalog, payload);
      } else result = await withPostgresLocale(catalog.regexLocale ?? "en_US.utf8",
        () => rest(catalog, url, env));
      const response = await jsonResponse(request, env, result, 200, generation, !result.errors);
      if (responseCache && response.status === 200 && !result.errors)
        context.waitUntil(responseCache.put(responseKey,response.clone()));
      return response;
    } catch (error) {
      const status = error instanceof CatalogError ? error.status : error instanceof SyntaxError ? 400 : 503;
      const message = error instanceof CatalogError || status === 400 ? error.message : "Catalog request failed; retry shortly";
      return jsonResponse(request, env, { error: message }, status, generation, false);
    }
  }
};
