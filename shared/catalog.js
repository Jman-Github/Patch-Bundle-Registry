import { gitHosts } from "./hosts.js";

export class CatalogError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function normalizeSource(value) {
  let url;
  try { url = new URL(value.includes("://") ? value : "https://" + value); }
  catch { throw new CatalogError("Invalid source URL"); }
  let host = url.hostname.toLowerCase();
  let path;
  try { path = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, "").replace(/\.git$/, ""); }
  catch { throw new CatalogError("Invalid encoded source URL"); }
  if (host === "api.github.com") { host = "github.com"; path = path.replace(/^repos\//, ""); }
  const kind = gitHosts[host === "github.com" && url.hostname === "api.github.com" ?
    "github.com" : url.host.toLowerCase()];
  if (kind === "gitlab") path = path.replace(/^api\/v4\/projects\//, "").split("/-/")[0];
  if (kind === "github") path = path.replace(/^api\/v3\/repos\//, "").replace(/^repos\//, "");
  if (kind === "gitea") path = path.replace(/^api\/v1\/repos\//, "");
  let parts = path.split("/");
  if (!kind || parts.length < 2 ||
      parts.some(p => !p || p === "." || p === ".."))
    throw new CatalogError("Expected a repository URL on a configured Git host");
  if (kind !== "gitlab") parts = parts.slice(0, 2);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new CatalogError("Expected a repository URL without credentials");
  return (host === "github.com" ? "https://github.com" : url.origin) + "/" + parts.join("/");
}
export function catalogOrigins(config, fallback) {
  if (!config.live_data) return [fallback];
  const repo = config.repository.split("/").map(encodeURIComponent).join("/");
  return ["https://raw.githubusercontent.com/" + repo + "/" +
    encodeURIComponent(config.data_branch) + "/" + (config.database_path ?? "database") + "/", fallback];
}
export function canonicalBundleType(value) {
  if (value === "ReSeam" || value?.startsWith("ReSeam:")) return value.replace("ReSeam", "Reseam");
  if (value === "ReVanced:V3") return "ReVanced:v21";
  if (value === "ReVanced:V4") return "ReVanced:v22";
  return value;
}
export function bundleTypeLabel(value) {
  value = canonicalBundleType(value);
  if (value === "ReVanced:v21") return "ReVanced v21";
  if (value === "ReVanced:v22") return "ReVanced v22";
  if (value?.startsWith("Morphe:")) return "Morphe";
  if (value === "Reseam" || value?.startsWith("Reseam:")) return "Reseam";
  return value;
}
export function bundleImages(bundle) {
  const source = bundle.source ?? {};
  const metadata = source.source_metadatum ?? {};
  const valid = value => {
    try {
      const url = new URL(value);
      return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  };
  let owner = valid(metadata.owner_avatar_url);
  // Public GitHub owner images remain usable without repository metadata.
  if (!owner) {
    try {
      const url = new URL(source.url);
      const namespace = metadata.owner_name || source.namespace || url.pathname.split("/")[1];
      if (url.hostname === "github.com" && namespace)
        owner = "https://github.com/" + encodeURIComponent(namespace) + ".png?size=96";
    } catch { /* Unknown host: use the website's initials fallback. */ }
  }
  const morphe = bundle.bundle_type?.startsWith("Morphe:");
  return { icon_url: (morphe && valid(metadata.bundle_icon_url)) || owner,
    owner_avatar_url: owner };
}
export function bundleImportPath(bundle, pinned = false) {
  const params = new URLSearchParams({ source_url: bundle.sourceUrl,
    version: pinned ? bundle.version : "latest",
    channel: bundle.isPrerelease ? "prerelease" : "stable" });
  return (canonicalBundleType(bundle.bundleType ?? bundle.bundle_type) === "Reseam" ? "/api/reseam/bundle?" : "/api/v3/bundle?") + params;
}
export function reseamNativeImportPath(bundle, pinned = false) {
  if (canonicalBundleType(bundle.bundleType ?? bundle.bundle_type) !== "Reseam") return null;
  return bundleImportPath(bundle, pinned).replace(/^\/api\/reseam\/bundle\?/, "/api/reseam/patches.json?");
}
export function releaseTimestamp(value) {
  let date = String(value ?? "");
  // Legacy snapshots store UTC dates without a timezone suffix.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(date)) date += "Z";
  const parsed = Date.parse(date);
  return Number.isFinite(parsed) ? parsed : -Infinity;
}
export function compareReleaseDates(a, b) {
  const left = releaseTimestamp(a.created_at), right = releaseTimestamp(b.created_at);
  return left === right ? 0 : right - left;
}
export function pagination(args = {}, maximum = 100) {
  const limit = Number(args.limit ?? 25), offset = Number(args.offset ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum ||
      !Number.isInteger(offset) || offset < 0 || offset > 10000)
    throw new CatalogError("limit must be 1–" + maximum + "; offset must be 0–10000");
  return { limit, offset };
}
let regexMatcher = () => { throw new CatalogError("Regex filters are available through the API"); };
export function configureRegexMatcher(matcher) { regexMatcher = matcher; }
let aggregateMatcher = () => { throw new CatalogError("Aggregate filters are available through the API"); };
export function configureAggregateMatcher(matcher) { aggregateMatcher = matcher; }
let textComparator = (a,b) => a < b ? -1 : a > b ? 1 : 0;
export function configureTextComparator(compare) { textComparator = compare; }
export function isTimestampField(row, key) {
  // GraphQL follows the upstream column types: release and repository dates
  // are text; only refresh-job dates are timestamps. REST keeps date sorting.
  const kind = row?.__kind ?? row?.__aggregateKind;
  return kind ? kind === "refresh_jobs" &&
    ["started_at", "completed_at"].includes(key) : key.endsWith("_at");
}
export function compareValues(left, right, timestamp = false) {
  if (timestamp) { left = Date.parse(left); right = Date.parse(right); }
  if (typeof left === "string" && typeof right === "string") return textComparator(left,right);
  return left < right ? -1 : left > right ? 1 : 0;
}
let caseFolder = value => value.toLowerCase();
export function configureCaseFolder(folder) { caseFolder = folder; }
function like(value, pattern, insensitive) {
  if (value == null) return false;
  pattern = String(pattern);
  if (pattern.length > 512) throw new CatalogError("Search pattern too long");
  const text = Array.from(insensitive ? caseFolder(String(value)) : String(value));
  const glob = [];
  const characters = Array.from(insensitive ? caseFolder(pattern) : pattern);
  for (let position = 0; position < characters.length; position++) {
    if (characters[position] === "\\") {
      if (++position === characters.length) throw new CatalogError("Incomplete LIKE escape");
      glob.push({ literal: characters[position] });
    } else glob.push({ value: characters[position] });
  }
  // SQL wildcards with bounded greedy matching; avoid regex backtracking.
  let i = 0, j = 0, star = -1, checkpoint = 0;
  while (i < text.length) {
    if (glob[j]?.value === "%") { star = j++; checkpoint = i; }
    else if (glob[j]?.value === "_" || (glob[j]?.literal ?? glob[j]?.value) === text[i]) { i++; j++; }
    else if (star >= 0) { j = star + 1; i = ++checkpoint; }
    else return false;
  }
  while (glob[j]?.value === "%") j++;
  return j === glob.length;
}
function combineConditions(items, predicate, disjunction = false) {
  let unknown = false;
  for (const item of items) {
    const result = predicate(item);
    if (result === disjunction) return disjunction;
    if (result == null) unknown = true;
  }
  return unknown ? null : !disjunction;
}
export function matches(row, where = {}, depth = 0) {
  return filterResult(row, where, depth) === true;
}
export function filterResult(row, where, depth = 0) {
  if (!where || typeof where !== "object" || Array.isArray(where) || depth > 12)
    throw new CatalogError("Invalid or excessively nested filter");
  // Keep SQL UNKNOWN until the complete condition has been evaluated. Collapsing
  // a missing value to false early would make NOT include it incorrectly.
  return combineConditions(Object.entries(where), ([key, condition]) => {
    if (key === "_and" || key === "_or") {
      if (!Array.isArray(condition)) throw new CatalogError("Logical filters must be arrays");
      return combineConditions(condition, c => filterResult(row, c, depth + 1), key === "_or");
    }
    if (key === "_not") {
      const result = filterResult(row, condition, depth + 1);
      return result == null ? null : !result;
    }
    if (condition == null) return true;
    if (key.endsWith("_aggregate") && Array.isArray(row[key.slice(0,-10)]))
      return aggregateMatcher(row[key.slice(0,-10)], condition);
    if (!(key in row)) throw new CatalogError("Unsupported filter field: " + key);
    const rawValue = row[key];
    const timestamp = isTimestampField(row, key) && typeof rawValue === "string" &&
      Number.isFinite(Date.parse(rawValue));
    const value = timestamp ? Date.parse(rawValue) : rawValue;
    // Relationship predicates use EXISTS: unknown comparisons in a related
    // row cannot satisfy the relation, and an empty relation is false.
    if (Array.isArray(value)) return value.some(v => matches(v, condition, depth + 1));
    if (value && typeof value === "object") return matches(value, condition, depth + 1);
    return combineConditions(Object.entries(condition ?? {}), ([op, input]) => {
      const expected = timestamp && input != null && op !== "_is_null" ?
        Array.isArray(input) ? input.map(v => Date.parse(v)) : Date.parse(input) : input;
      switch (op) {
        case "_eq": return value == null || expected == null ? null : value === expected;
        case "_neq": return value == null || expected == null ? null : value !== expected;
        case "_in": case "_nin": {
          const found = !expected.length ? false : value == null ? null :
            expected.includes(value) ? true : expected.includes(null) ? null : false;
          return op === "_in" || found == null ? found : !found;
        }
        case "_is_null": return (value == null) === expected;
        case "_ilike": case "_like":
          return value == null || expected == null ? null : like(value, expected, op === "_ilike");
        case "_nlike": case "_nilike":
          return value == null || expected == null ? null : !like(value, expected, op === "_nilike");
        case "_regex": case "_iregex": case "_nregex": case "_niregex":
        case "_similar": case "_nsimilar": {
          if (value == null || expected == null) return null;
          const found = regexMatcher(String(value), expected, op);
          return op.startsWith("_n") ? !found : found;
        }
        case "_gt": return value == null || expected == null ? null : compareValues(value, expected) > 0;
        case "_gte": return value == null || expected == null ? null : compareValues(value, expected) >= 0;
        case "_lt": return value == null || expected == null ? null : compareValues(value, expected) < 0;
        case "_lte": return value == null || expected == null ? null : compareValues(value, expected) <= 0;
        default: throw new CatalogError("Unsupported filter operator: " + op);
      }
    });
  });
}
function sortKeys(order, prefix = []) {
  return (Array.isArray(order) ? order : [order]).flatMap(part =>
    Object.entries(part ?? {}).flatMap(([key, direction]) =>
      typeof direction === "object" ? sortKeys(direction, [...prefix, key]) :
        [{ path: [...prefix, key], direction }]));
}
export function selectRows(rows, args = {}, maximum = 100) {
  const { limit, offset } = pagination(args, maximum);
  let result = rows.filter(row => matches(row, args.where ?? {}));
  const keys = sortKeys(args.order_by ?? { id: "asc" });
  if (keys.some(k => !["asc", "desc", "asc_nulls_first", "asc_nulls_last",
                      "desc_nulls_first", "desc_nulls_last"].includes(k.direction)))
    throw new CatalogError("Invalid order direction");
  result = result.slice().sort((a, b) => {
    for (const { path, direction } of keys) {
      const leftValue = path.reduce((v, k) => v?.[k], a);
      const rightValue = path.reduce((v, k) => v?.[k], b);
      const parent = path.slice(0, -1).reduce((v, k) => v?.[k], a);
      const timestamp = isTimestampField(parent, path.at(-1));
      const left = timestamp && leftValue != null ? Date.parse(leftValue) : leftValue;
      const right = timestamp && rightValue != null ? Date.parse(rightValue) : rightValue;
      if (left == null && right == null) continue;
      const ascending = direction.startsWith("asc");
      const nullsFirst = direction.endsWith("nulls_first") ||
        (!ascending && !direction.endsWith("nulls_last"));
      if (left == null || right == null) return left == null ? (nullsFirst ? -1 : 1) :
        (nullsFirst ? 1 : -1);
      const compared = compareValues(left,right);
      if (compared) return ascending ? compared : -compared;
    }
    return String(a.id ?? a.name).localeCompare(String(b.id ?? b.name));
  });
  if (args.distinct_on?.length) {
    const seen = new Set();
    result = result.filter(row => {
      const key = JSON.stringify(args.distinct_on.map(field => row[field]));
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  }
  return { data: result.slice(offset, offset + limit), total: result.length, limit, offset };
}
export function packageFilterMatches(packages, query) {
  const value = query.trim().toLowerCase();
  const [name, version] = value.split("@", 2);
  return packages.some(pkg => version !== undefined ?
    pkg.name.toLowerCase().includes(name) &&
      (!version || !pkg.versions.length || pkg.versions.some(v => String(v).toLowerCase() === version)) :
    (pkg.name + " " + (pkg.app_name || "")).toLowerCase().includes(value) ||
      pkg.versions.some(v => String(v).toLowerCase().includes(value)));
}
export function patchPackages(patch) {
  return patch.packages.flatMap(p => (p.versions.length ? p.versions : [null]).map(version =>
    ({ package: { name: p.name, version, app_name: p.app_name ?? p.name, icon_url: p.icon_url ?? null }, patch_id: patch.id })));
}
export class Catalog {
  constructor(base, fetcher = fetch, enforceBudget = true) {
    this.enforceBudget = enforceBudget;
    this.base = base.endsWith("/") ? base : base + "/";
    this.fetcher = (...args) => fetcher.call(globalThis, ...args);
    this.loaded = new Map();
    this.bytes = 0;
    this.requests = 0;
  }
  async initialize() {
    const response = await this.fetcher(new URL("manifest.json", this.base), { cache: "no-cache" });
    if (!response.ok) throw new CatalogError("Catalog manifest unavailable", 503);
    const manifest = await response.json();
    if (manifest.schema_version !== 1 ||
        !/^snapshots\/[a-f0-9]{24}$/.test(manifest.snapshot) ||
        manifest.snapshot !== "snapshots/" + manifest.generation)
      throw new CatalogError("Invalid catalog generation", 503);
    if (manifest.snapshot_ref !== undefined && !/^[a-f0-9]{40}$/.test(manifest.snapshot_ref))
      throw new CatalogError("Invalid catalog snapshot reference",503);
    this.manifest = manifest;
    this.snapshotBase = new URL(this.base);
    // The branch manifest can outlive retention at HEAD. Commit URLs keep
    // lazy reads available even after that generation is pruned from the branch.
    if (manifest.snapshot_ref && this.snapshotBase.hostname === "raw.githubusercontent.com") {
      const parts = this.snapshotBase.pathname.split("/");
      if (parts.length < 5) throw new CatalogError("Invalid GitHub catalog origin",503);
      parts[3] = manifest.snapshot_ref;
      this.snapshotBase.pathname = parts.join("/");
    }
    return this;
  }
  async file(name) {
    if (!this.loaded.has(name)) {
      const metadata = this.manifest.files[name];
      if (!metadata || name.includes("..") || name.startsWith("/"))
        throw new CatalogError("Unknown catalog index", 503);
      this.requests++;
      this.bytes += metadata.bytes;
      if (this.enforceBudget && (this.requests > 36 || this.bytes > 12 * 1024 * 1024))
        throw new CatalogError("Query exceeds catalog budget; narrow the source or package filter", 422);
      this.loaded.set(name, (async () => {
        const response = await this.fetcher(new URL(this.manifest.snapshot + "/" + name, this.snapshotBase));
        if (!response.ok) {
          const error = new CatalogError("Catalog generation unavailable; retry shortly", 503);
          error.generationUnavailable = response.status === 404 || response.status === 410;
          throw error;
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length !== metadata.bytes) throw new CatalogError("Catalog size mismatch", 503);
        const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
          .map(n => n.toString(16).padStart(2, "0")).join("");
        if (hash !== metadata.sha256) throw new CatalogError("Catalog integrity mismatch", 503);
        const data = JSON.parse(new TextDecoder().decode(bytes));
        if (name === "bundles.json" || name === "app-bundles.json" ||
            name.startsWith("imports/")) return data.map(row => ({
          ...row, bundle_type: canonicalBundleType(row.bundle_type)
        }));
        if (/^bundles\//.test(name)) data.bundle_type = canonicalBundleType(data.bundle_type);
        return data;
      })());
    }
    try { return await this.loaded.get(name); }
    catch (error) { this.loaded.delete(name); throw error; }
  }
  async sources() { return this.file("sources.json"); }
  async apps() {
    if (this.manifest.files["apps.json"]) return this.file("apps.json");
    // Older snapshots remain usable while the first metadata refresh runs.
    const bundles = await this.bundles();
    const apps = (await this.file("packages.json")).map(packageRow => ({
      package_name: packageRow.name, app_name: packageRow.app_name || packageRow.name,
      icon_url: packageRow.icon_url || null, metadata_source: null, bundles: []
    }));
    const byPackage = new Map(apps.map(app => [app.package_name, app]));
    for (const bundle of bundles) for (const name of bundle.packages)
      byPackage.get(name)?.bundles.push({
        bundle_id: bundle.id, patch_count: 0,
        versions: [], unrestricted: false, compatibility_unknown: true
      });
    return apps;
  }
  async bundleApps(id) {
    const name = "bundle-apps/" + id + ".json";
    if (this.manifest.files[name]) return this.file(name);
    return (await this.apps()).flatMap(app => app.bundles
      .filter(reference => reference.bundle_id === id)
      .map(reference => ({ package_name: app.package_name, app_name: app.app_name,
        icon_url: app.icon_url, metadata_source: app.metadata_source ?? null, ...reference })));
  }
  async importBundles(sourceUrl) {
    const canonical = normalizeSource(sourceUrl).toLowerCase();
    const source = (await this.sources()).find(row => row.url.toLowerCase() === canonical);
    if (!source || source.enabled === false) return [];
    const name = "imports/" + source.id + ".json";
    // Older published snapshots predate the compact source index.
    const rows = await this.file(this.manifest.files[name] ? name : "bundles.json");
    return rows.filter(bundle => bundle.source_id === source.id).map(bundle => ({ ...bundle, source }));
  }
  async bundles({ compact = false } = {}) {
    const sources = new Map((await this.sources()).map(source => [source.id, source]));
    const index = compact && this.manifest.files["app-bundles.json"] ? "app-bundles.json" : "bundles.json";
    return (await this.file(index))
      .filter(bundle => sources.get(bundle.source_id)?.enabled !== false).map(bundle => ({
      ...bundle, source: sources.get(bundle.source_id),
      ...bundleImages({ ...bundle, source: sources.get(bundle.source_id) })
    }));
  }
  async changelogBundles() {
    this.changelogIndex ??= (async () => {
      // D1 bootstraps only current bundles. Read the full index on older snapshots.
      const compact = Boolean(this.manifest.files["changelogs.json"]);
      const [index, sources] = await Promise.all([
        this.file(compact ? "changelogs.json" : "bundles.json"), this.sources()
      ]);
      const byId = new Map(sources.filter(source => source.enabled !== false)
        .map(source => [source.id, source]));
      const rows = compact ? index.rows.map(values =>
        Object.fromEntries(index.columns.map((column, i) => [column, values[i]]))
      ) : index.filter(bundle => bundle.availability !== "unavailable" && bundle.description?.trim());
      return rows.flatMap(bundle => {
        const source = byId.get(bundle.source_id);
        return source ? [{ ...bundle, source, bundle_type: canonicalBundleType(bundle.bundle_type) }] : [];
      });
    })().catch(error => {
      this.changelogIndex = null;
      throw error;
    });
    return this.changelogIndex;
  }
  async patchRows({ q = "", package: packageName, bundle_id: bundleId, bundle_ids: bundleIds, page_cursor = 0,
                    page_count = 12, all = false, include_unverified = false, patch_id: patchId, patch_ids: patchIds,
                    compact_bundles = false, bundle_rows: bundleRows, reverse_pages = false } = {}) {
    const scoped = (bundleId || bundleIds) && !packageName && patchId == null &&
      !patchIds && this.manifest.files["patch-bundle-index.json"];
    let index, pages;
    if (scoped) {
      const bundles = await this.file("patch-bundle-index.json");
      const ids = bundleIds ?? [bundleId];
      pages = [...new Set(ids.flatMap(id =>
        Object.hasOwn(bundles,id) ? bundles[id] : []))].sort();
      index = { bundles };
    } else {
      index = await this.file("patch-index.json");
      pages = index.pages;
    }
    function intersect(candidate) {
      const selected = new Set(candidate ?? []);
      pages = pages.filter(page => selected.has(page));
    }
    function own(indexRows, key) {
      return indexRows && Object.hasOwn(indexRows,key) ? indexRows[key] : [];
    }
    if (patchId != null && index.patch_ids) intersect(own(index.patch_ids,String(patchId)));
    if (patchIds && index.patch_ids)
      intersect(patchIds.flatMap(id => own(index.patch_ids,String(id))));
    if (bundleId) intersect(own(index.bundles,bundleId));
    if (bundleIds) intersect(bundleIds.flatMap(id => own(index.bundles,id)));
    if (packageName) intersect(own(index.packages,packageName));
    const unicodeSearch = /[^\x00-\x7F]/.test(q);
    q = q.toLowerCase();
    if (q.length > 512) throw new CatalogError("Search text too long");
    const characters = Array.from(q);
    // Unicode postings are generated with JavaScript lowercase semantics,
    // independently of Python's Unicode tables. Read a few small buckets,
    // without loading the full Unicode patch text on every search.
    const modernUnicode = unicodeSearch && this.manifest.files["search-unicode-v2/0-0.json"];
    let unicodePages = null;
    if (modernUnicode && characters.length < 3) {
      const bucket = characters.length === 1 ?
        "search-unicode-short/1-" + (characters[0].codePointAt(0) % 16) + ".json" :
        "search-unicode-short/2-" + (characters[0].codePointAt(0) % 16) + "-" +
          (characters[1].codePointAt(0) % 16) + ".json";
      unicodePages = this.manifest.files[bucket] ? (await this.file(bucket))[q] ?? [] : [];
    } else if (modernUnicode) {
      const grams = new Map();
      for (let i = 0; i < characters.length - 2; i++) {
        const gram = characters.slice(i,i+3).join("");
        const bucket = "search-unicode-v2/" + (characters[i].codePointAt(0) % 16) +
          "-" + (characters[i+1].codePointAt(0) % 16) + ".json";
        grams.set(gram,bucket);
      }
      const cheapest = [...grams].sort((a,b) =>
        (this.manifest.files[a[1]]?.bytes ?? Infinity) -
        (this.manifest.files[b[1]]?.bytes ?? Infinity));
      const loaded = new Map();
      let bytes = 0, chosen = 0;
      for (const [gram,bucket] of cheapest) {
        const added = loaded.has(bucket) ? 0 : this.manifest.files[bucket]?.bytes ?? 0;
        if (chosen && bytes + added > 2 * 1024 * 1024) continue;
        if (!loaded.has(bucket)) loaded.set(bucket, await this.file(bucket));
        const postings = loaded.get(bucket)[gram] ?? [];
        const selected = new Set(postings);
        unicodePages = unicodePages === null ? postings :
          unicodePages.filter(page => selected.has(page));
        bytes += added;
        if (++chosen === 3 || !unicodePages.length) break;
      }
      unicodePages ??= [];
    } else if (unicodeSearch && this.manifest.files["search-unicode-text.json"]) {
      // Snapshots written before the sharded index use original text.
      unicodePages = Object.entries(await this.file("search-unicode-text.json"))
        .filter(([,texts]) => texts.some(text => text.toLowerCase().includes(q)))
        .map(([page]) => page);
    }
    function intersectSearch(candidate) {
      intersect(unicodePages ? [...(candidate ?? []), ...unicodePages] : candidate);
    }
    if (unicodeSearch && !unicodePages) {
      // Older snapshots without a Unicode index must scan scoped pages.
    } else if (unicodeSearch && /[^\x00-\x7F]/.test(q)) {
      intersect(unicodePages);
    } else if (characters.length && characters.length < 3) {
      const bucket = characters.length === 1 ?
        "search-short/1-" + (characters[0].codePointAt(0) % 16) + ".json" :
        "search-short/2-" + (characters[0].codePointAt(0) % 16) + "-" +
          (characters[1].codePointAt(0) % 16) + ".json";
      if (this.manifest.files[bucket]) intersectSearch((await this.file(bucket))[q]);
      else if (this.manifest.files["search-v2/0-0.json"]) {
        // New snapshots intentionally omit empty short-search buckets. Their
        // absence means no public matches, unlike older snapshots without a
        // short-search index, which must retain the full-scan fallback.
        intersectSearch([]);
      }
    } else if (characters.length >= 3) {
      const buckets = new Map();
      const candidateGrams = new Map();
      for (let i = 0; i < characters.length - 2; i++) {
        const gram = characters.slice(i, i + 3).join("");
        const first = characters[i].codePointAt(0) % 16;
        const second = characters[i + 1].codePointAt(0) % 16;
        const v2 = "search-v2/" + first + "-" + second + ".json";
        const bucket = this.manifest.files[v2] ? v2 : "search/" + first + ".json";
        candidateGrams.set(gram, bucket);
      }
      // A few indexed trigrams form a safe superset of the matches. The
      // complete substring check below retains exact results, without loading
      // dozens of large index files for long searches.
      const cheapest = [...candidateGrams].sort((a,b) =>
        (this.manifest.files[a[1]]?.bytes ?? Infinity) -
        (this.manifest.files[b[1]]?.bytes ?? Infinity));
      let indexBytes = 0, chosen = 0;
      for (const [gram,bucket] of cheapest) {
        const added = buckets.has(bucket) ? 0 : this.manifest.files[bucket]?.bytes ?? 0;
        if (chosen && indexBytes + added > 2 * 1024 * 1024) continue;
        if (!buckets.has(bucket)) buckets.set(bucket, await this.file(bucket));
        intersectSearch(buckets.get(bucket)[gram]);
        indexBytes += added;
        if (++chosen === 3 || !pages.length) break;
      }
    }
    if (all && pages.length > 24)
      throw new CatalogError("Patch query spans too many shards; filter by bundle or package", 422);
    if (reverse_pages) pages = pages.slice().reverse();
    if (!Number.isInteger(+page_cursor) || +page_cursor < 0 || +page_cursor > pages.length)
      throw new CatalogError("Invalid page_cursor");
    const selected = all ? pages : pages.slice(+page_cursor, +page_cursor + page_count);
    if (!selected.length) return { rows: [], next_cursor: null, candidate_pages: pages.length };
    const bundles = new Map((bundleRows ?? await this.bundles({ compact: compact_bundles }))
      .map(b => [b.id, b]));
    const candidates = (await Promise.all(selected.map(page => this.file(page))))
      .flatMap(page => reverse_pages ? page.slice().reverse() : page);
    const rows = candidates
      .filter(p => bundles.has(p.bundle_id) && (!patchIds || patchIds.includes(p.legacy_id)) &&
        (include_unverified || p.metadata_status === "verified") &&
        (!q || ((p.name ?? "") + " " + (p.description ?? "")).toLowerCase().includes(q)) &&
        (!bundleId || p.bundle_id === bundleId) &&
        (!bundleIds || bundleIds.includes(p.bundle_id)) &&
        (!packageName || p.packages.some(pkg => pkg.name === packageName)))
      .map(p => ({ ...p, bundle: bundles.get(p.bundle_id), patch_packages: patchPackages(p) }));
    const next = +page_cursor + selected.length;
    return { rows, next_cursor: next < pages.length ? next : null,
             candidate_pages: pages.length };
  }
}
