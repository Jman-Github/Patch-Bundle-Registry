import { Catalog, CatalogError, bundleImages, normalizeSource, patchPackages, selectRows } from "../../shared/catalog.js";
import { execute, getNamedType, TypeInfo, visit, visitWithTypeInfo, valueFromASTUntyped } from "graphql";

const relations = {
  source: { bundles: ["bundle", "id", "source_fk"], source_metadatum: ["source_metadata", "id", "source_fk"] },
  source_metadata: { source: ["source", "source_fk", "id"] },
  bundle: { source: ["source", "source_fk", "id"], patches: ["patch", "id", "bundle_fk"] },
  patch: { bundle: ["bundle", "bundle_fk", "id"], patch_packages: ["patch_package", "id", "patch_fk"] },
  package: { patch_packages: ["patch_package", "id", "package_fk"] },
  patch_package: { package: ["package", "package_fk", "id"], patch: ["patch", "patch_fk", "id"] }
};
const kinds = new Set(["source", "source_metadata", "bundle", "patch", "package",
  "patch_package", "app", "refresh_jobs", "history_release", "history_source"]);
const safe = /^[a-zA-Z_][a-zA-Z_0-9]*$/;
const col = (alias, field) => {
  if (!safe.test(field)) throw new CatalogError("Invalid query field");
  return "json_extract(" + alias + ".data,'$." + field + "')";
};
class Unsupported extends CatalogError {
  constructor() {super("Historical query uses an unsupported filter or ordering; use equality, membership and numeric ordering",422);}
}

const documentCaches = new WeakMap();

export class D1Catalog extends Catalog {
  constructor(env, {cacheDocuments = false} = {}) {
    super("https://catalog.invalid/", fetch);
    this.env = env;
    this.cacheDocuments = cacheDocuments;
    const session = env.DB.withSession ? env.DB.withSession("first-primary") : env.DB;
    this.queryCache = new Map();
    this.db = {prepare: sql => {
      let statement = session.prepare(sql), bindings = [];
      const run = mode => {
        const key = JSON.stringify([sql,bindings,mode]);
        if (!this.queryCache.has(key)) {
          if (this.queryCache.size >= 300) throw new CatalogError("Query exceeds database budget",422);
          this.queryCache.set(key,statement[mode]());
        }
        return this.queryCache.get(key);
      };
      const wrapper = {bind(...args) {bindings=args;statement=statement.bind(...args);return wrapper;},
        all:()=>run("all"),first:()=>run("first")};
      return wrapper;
    }};
  }
  async initialize() {
    const active = await this.db.prepare(
      "SELECT g.* FROM catalog_state s JOIN catalog_generations g ON g.seq=s.active_seq " +
      "WHERE s.id=1 AND g.status='ready'").first();
    if (!active) throw new CatalogError("D1 catalog has not been imported", 503);
    const load = async () => {
      const object = await this.env.ARCHIVE.get(active.manifest_key);
      if (!object) throw new CatalogError("Catalog snapshot unavailable",503);
      const document = await object.json();
      if (document.manifest.generation !== active.generation)
        throw new CatalogError("Catalog generation mismatch",503);
      return document;
    };
    if (this.cacheDocuments) {
      let cache = documentCaches.get(this.env.ARCHIVE);
      if (!cache) documentCaches.set(this.env.ARCHIVE,cache=new Map());
      const key = active.generation + ":" + active.manifest_key;
      if (!cache.has(key)) {
        if (cache.size >= 2) cache.delete(cache.keys().next().value);
        const pending = load();
        cache.set(key,pending);
        pending.then(document=>{
          // Bound retained manifests by bytes as well as entry count.
          if (new TextEncoder().encode(JSON.stringify(document)).length > 8*1024*1024 && cache.get(key)===pending) cache.delete(key);
        },()=>{if (cache.get(key)===pending) cache.delete(key);});
      }
      this.document = await cache.get(key);
    } else this.document = await load();
    this.manifest = this.document.manifest;
    if (this.manifest.generation !== active.generation)
      throw new CatalogError("Catalog generation mismatch", 503);
    if (!Number.isSafeInteger(active.seq) || active.seq < 1)
      throw new CatalogError("Invalid catalog sequence",503);
    this.seq = active.seq;
    return this;
  }
  visible(alias) { return alias + ".from_seq<=" + this.seq +
    " AND (" + alias + ".to_seq IS NULL OR " + alias + ".to_seq>" + this.seq + ")"; }
  async file(name) {
    if (!this.loaded.has(name)) this.loaded.set(name, (async () => {
      const digest = this.document.files[name];
      if (!/^[a-f0-9]{64}$/.test(digest ?? "")) throw new CatalogError("Unknown catalog index", 503);
      const metadata = this.manifest.files[name];
      this.requests++;
      this.bytes += metadata?.bytes ?? 0;
      if (this.requests > 36 || this.bytes > 12 * 1024 * 1024)
        throw new CatalogError("Query exceeds catalog budget; narrow the source or package filter",422);
      const object = await this.env.ARCHIVE.get("objects/" + digest);
      if (!object) throw new CatalogError("Catalog object unavailable", 503);
      return object.json();
    })());
    try { return await this.loaded.get(name); }
    catch (error) { this.loaded.delete(name); throw error; }
  }
  where(kind, where = {}, alias = "r", bindings = [], depth = 0) {
    if (depth > 12) throw new CatalogError("Filter nesting limit exceeded");
    const terms = [];
    for (const [field, condition] of Object.entries(where ?? {})) {
      if (field === "_and" || field === "_or") {
        const items = condition.map(item => this.where(kind, item, alias, bindings, depth + 1));
        terms.push("(" + (items.join(field === "_and" ? " AND " : " OR ") ||
          (field === "_and" ? "1" : "0")) + ")");
      } else if (field === "_not") {
        terms.push("NOT (" + this.where(kind, condition, alias, bindings, depth + 1) + ")");
      } else if (relations[kind]?.[field]) {
        const [target, parentKey, childKey] = relations[kind][field];
        const child = "r" + (depth + 1);
        terms.push("EXISTS(SELECT 1 FROM catalog_records " + child +
          " WHERE " + child + ".kind='" + target + "' AND " + this.visible(child) +
          " AND " + col(child, childKey) + "=" + col(alias, parentKey) +
          " AND " + this.where(target, condition, child, bindings, depth + 1) + ")");
      } else {
        if (field.endsWith("_aggregate")) throw new Unsupported();
        const expression = col(alias, field);
        for (const [op, value] of Object.entries(condition ?? {})) {
          if (op === "_is_null") terms.push(expression + (value ? " IS NULL" : " IS NOT NULL"));
          else if (op === "_in" || op === "_nin") {
            if (!Array.isArray(value) || value.length > 80) throw new Unsupported();
            if (!value.length) terms.push(op === "_in" ? "0" : "1");
            else {
              bindings.push(...value.map(v => typeof v === "boolean" ? Number(v) : v));
              terms.push(expression + (op === "_in" ? " IN (" : " NOT IN (") +
                value.map(() => "?").join(",") + ")");
            }
          } else if (["_eq", "_neq", "_gt", "_gte", "_lt", "_lte"].includes(op)) {
            // Text ordering must keep the existing PostgreSQL locale semantics.
            if (typeof value === "string" && !["_eq", "_neq"].includes(op))
              throw new Unsupported();
            bindings.push(typeof value === "boolean" ? Number(value) : value);
            terms.push(expression + ({_eq:"=",_neq:"<>",_gt:">",_gte:">=",_lt:"<",_lte:"<="}[op]) + "?");
          } else throw new Unsupported();
        }
      }
    }
    return terms.join(" AND ") || "1";
  }
  order(args, alias = "r") {
    const result = [];
    for (const order of Array.isArray(args.order_by) ? args.order_by : args.order_by ? [args.order_by] : []) {
      for (const [field, direction] of Object.entries(order)) {
        if (typeof direction !== "string") throw new Unsupported();
        // Numeric IDs and ISO/text dates cover Android discovery. Locale sorts use fallback.
        if (!["id", "catalog_id", "source_fk", "bundle_fk", "patch_count"].includes(field))
          throw new Unsupported();
        if (!/^(asc|desc)(_nulls_(first|last))?$/.test(direction)) throw new Unsupported();
        const descending = direction.startsWith("desc");
        const nulls = direction.endsWith("first") || direction === "desc" ? "FIRST" : "LAST";
        result.push(col(alias, field) + (descending ? " DESC" : " ASC") + " NULLS " + nulls);
      }
    }
    if (!result.length) result.push(col(alias,"id") + " ASC NULLS LAST");
    result.push("CAST(" + col(alias,"id") + " AS TEXT) ASC",alias + ".record_key ASC");
    return result.join(",");
  }
  publicFilter(kind,args) {
    if (args.include_archived) return args.where;
    const bundle = {source:{enabled:{_eq:true}},_or:[
      {availability:{_is_null:true}}, {availability:{_neq:"unavailable"}}
    ]};
    const visibility = kind === "bundle" ? bundle :
      kind === "patch" ? {bundle} :
      kind === "patch_package" ? {patch:{bundle}} :
      kind === "package" ? {patch_packages:{patch:{bundle}}} : null;
    return visibility ? {_and:[args.where ?? {},visibility]} : args.where;
  }
  async rows(kind, args = {}, extra = null, maximum = 100) {
    if (!kinds.has(kind)) throw new Unsupported();
    if (args.generation && args.generation !== this.manifest.generation)
      throw new CatalogError("Catalog changed; restart history pagination",409);
    if (args.distinct_on?.length || args.q || args.package_name || args.bundle_id) throw new Unsupported();
    const limit = Number(args.limit ?? 25), offset = Number(args.offset ?? 0);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum ||
        !Number.isSafeInteger(offset) || offset < 0) throw new CatalogError("Invalid pagination");
    const bindings = [kind];
    let filter = this.where(kind, this.publicFilter(kind,args), "r", bindings);
    if (extra) {
      bindings.push(extra.value);
      filter += " AND " + col("r", extra.field) + "=?";
    }
    if (bindings.length > 95) throw new Unsupported();
    // Sort only record identities: retaining full JSON bodies up to a deep offset
    // exhausts D1's sorter memory. Load bodies after the requested page is known.
    const query = "SELECT r.data FROM (SELECT r.kind,r.record_key,r.from_seq FROM catalog_records r WHERE r.kind=? AND " +
      this.visible("r") + " AND " + filter + " ORDER BY " + this.order(args) + " LIMIT ? OFFSET ?) AS page " +
      "CROSS JOIN catalog_records r ON r.kind=page.kind AND r.record_key=page.record_key AND r.from_seq=page.from_seq " +
      "ORDER BY " + this.order(args);
    const result = await this.db.prepare(query).bind(...bindings, limit, offset).all();
    return result.results.map(item => ({ ...JSON.parse(item.data), __kind: kind, __archived:Boolean(args.include_archived) }));
  }
  async count(kind, args = {}, extra = null, countArgs = {}) {
    const bindings = [kind];
    let filter = this.where(kind, this.publicFilter(kind,args), "r", bindings);
    if (extra) { bindings.push(extra.value); filter += " AND " + col("r",extra.field) + "=?"; }
    if (bindings.length > 95) throw new Unsupported();
    const columns = countArgs.columns ?? [];
    const projection = columns.length ?
      columns.map((field,index)=>col("r",field)+" AS v"+index).join(",") : "1";
    const inner = "SELECT " + projection + " FROM catalog_records r WHERE r.kind=? AND " +
      this.visible("r") + " AND " + filter;
    const constrained = args.limit != null || args.offset;
    if (args.limit != null && (!Number.isInteger(args.limit) || args.limit < 0 || args.limit > 100))
      throw new CatalogError("Invalid aggregate limit");
    if (args.offset != null && (!Number.isSafeInteger(args.offset) || args.offset < 0))
      throw new CatalogError("Invalid aggregate offset");
    const window = inner + (constrained ? " ORDER BY " + this.order(args) + " LIMIT ? OFFSET ?" : "");
    if (constrained) bindings.push(args.limit ?? -1, args.offset ?? 0);
    const projected = columns.length ? "SELECT " + (countArgs.distinct ? "DISTINCT " : "") +
      columns.map((_,index)=>"v"+index).join(",") + " FROM ("+window+") WHERE " +
      columns.map((_,index)=>"v"+index+" IS NOT NULL").join(" AND ") : window;
    return (await this.db.prepare("SELECT COUNT(*) AS n FROM ("+projected+")")
      .bind(...bindings).first()).n;
  }
  async scan(kind, where = {}, extra = null) {
    const bindings=[kind];
    let filter=this.where(kind,this.publicFilter(kind,{where}),"r",bindings);
    if (extra) {filter+=" AND ("+extra.sql+")";bindings.push(...extra.bindings);}
    const result=[];
    let after="";
    while (true) {
      const page=(await this.db.prepare("SELECT r.record_key,r.data FROM catalog_records r WHERE r.kind=? AND "+
        this.visible("r")+" AND "+filter+" AND r.record_key>? ORDER BY r.record_key LIMIT 100")
        .bind(...bindings,after).all()).results;
      for (const item of page) result.push({...JSON.parse(item.data),__kind:kind});
      if (page.length<100) break;
      after=page.at(-1).record_key;
    }
    return result;
  }
  async browse(kind, params, args, accept) {
    const sources=await this.scan("source");
    const byId=new Map(sources.map(row=>[row.id,row]));
    const bindings=[kind];
    let filter=this.where(kind,this.publicFilter(kind,{where:args.where}),"r",bindings);
    if (kind==="bundle") {
      for (const [param,field] of [["package","packages"],["channel","channels"]]) if (params.has(param)) {
        const aliases={any:"latest",latest:"latest",stable:"stable",dev:"dev",prerelease:"dev"};
        const raw=params.get(param),value=param==="channel"?aliases[raw.trim().toLowerCase()]:raw;
        if (typeof value!=="string") throw new CatalogError("Invalid channel");
        filter+=" AND EXISTS(SELECT 1 FROM json_each(r.data,'$."+field+"') WHERE value=?)";
        bindings.push(value);
      }
      const q=(params.get("q")??"").toLowerCase();
      if (q && /^[\x00-\x7f]*$/.test(q)) {
        const sourceIds=sources.filter(row=>(row.url+" "+(row.aliases??[]).join(" ")).toLowerCase().includes(q)).map(row=>row.id);
        // SQLite lower() folds ASCII only. Include non-ASCII candidates and
        // apply the exact JavaScript predicate below to preserve Unicode matches.
        const text="COALESCE("+col("r","description")+",'')||' '||COALESCE("+col("r","version")+",'')";
        filter+=" AND (instr(lower("+text+"),?)>0 OR "+text+" GLOB '*[^ -~]*' OR "+
          col("r","source_fk")+" IN (SELECT value FROM json_each(?)))";
        bindings.push(q,JSON.stringify(sourceIds));
      }
    }
    const candidates=[];
    let after="";
    while (true) {
      const page=(await this.db.prepare("SELECT r.record_key,r.data FROM catalog_records r WHERE r.kind=? AND "+
        this.visible("r")+" AND "+filter+" AND r.record_key>? ORDER BY r.record_key LIMIT 100")
        .bind(...bindings,after).all()).results;
      for (const item of page) {
        const raw={...JSON.parse(item.data),__kind:kind};
        const row={...raw,id:raw.catalog_id,legacy_id:raw.id};
        if (kind==="bundle") row.source=byId.get(raw.source_fk);
        if (!accept(row)) continue;
        // Sorting needs only scalar fields; do not retain growing release notes.
        const {description,source,packages,channels,...small}=row;
        candidates.push({id:small.id,version:small.version,created_at:small.created_at,
          patch_count:small.patch_count,url:small.url,repo:small.repo});
      }
      if (page.length<100) break;
      after=page.at(-1).record_key;
    }
    // SQL and accept already applied the filters before reducing rows to sort fields.
    const selected=selectRows(candidates,{...args,where:undefined});
    const wanted=selected.data.map(row=>row.id);
    if (!wanted.length) return selected;
    const data=(await this.db.prepare("SELECT r.data FROM catalog_records r WHERE r.kind=? AND "+
      this.visible("r")+" AND "+col("r","catalog_id")+" IN (SELECT value FROM json_each(?))")
      .bind(kind,JSON.stringify(wanted)).all()).results;
    const rows=new Map(data.map(item=>{const row=JSON.parse(item.data);return [row.catalog_id,{...row,__kind:kind}];}));
    selected.data=await this.restRows(wanted.map(id=>rows.get(id)));
    return selected;
  }
  async legacyBundles(owner, repo, version, mode) {
    const sources=(await this.scan("source")).filter(source=>
      (source.source_metadatum?.owner_name??source.namespace)===owner &&
      (source.source_metadatum?.repo_name??source.repo)===repo && source.enabled!==false);
    const where={};
    if (version==="latest") {
      where.is_latest={_eq:true};
      if (mode!=="latest") where.is_prerelease={_eq:mode==="dev"};
    } else where.version={_eq:version};
    const rows=await this.scan("bundle",where,{sql:col("r","source_fk")+" IN (SELECT value FROM json_each(?))",
      bindings:[JSON.stringify(sources.map(row=>row.id))]});
    return this.restRows(rows);
  }
  async sourceIds(identifier) {
    const url = identifier.includes("/") ? normalizeSource(identifier).toLowerCase() : identifier.toLowerCase();
    const rows = await this.db.prepare("SELECT json_extract(r.data,'$.id') AS id FROM catalog_records r " +
      "WHERE r.kind='source' AND " + this.visible("r") +
      " AND (LOWER(json_extract(r.data,'$.url'))=? OR json_extract(r.data,'$.catalog_id')=?" +
      " OR EXISTS(SELECT 1 FROM json_each(r.data,'$.aliases') WHERE value=?))")
      .bind(url,identifier,identifier).all();
    return rows.results.map(row=>row.id);
  }
  async importBundles(sourceUrl, selection = {}) {
    const ids = await this.sourceIds(sourceUrl);
    const where = {source:{id:{_in:ids},enabled:{_eq:true}}};
    if (selection.latest) where.is_latest = {_eq:true};
    else if (selection.version) where.version = {_eq:selection.version};
    const rows = await this.rows("bundle",{where,limit:100});
    return this.restRows(rows);
  }
  async patchWindow(params, bundleId) {
    const bindings=["patch"];
    let filter=this.where("patch",this.publicFilter("patch",{}),"r",bindings);
    filter += " AND " + col("r","hidden") + " IS NOT 1 AND " + col("r","loader_excluded") + " IS NOT 1";
    const same=(field,value)=>{filter+=" AND "+col("r",field)+"=?";bindings.push(value);};
    if (bundleId) same("bundle_id",bundleId);
    if (params.get("include_unverified")!=="true") same("metadata_status","verified");
    if (params.has("package")) {
      filter+=" AND EXISTS(SELECT 1 FROM json_each(r.data,'$.packages') WHERE json_extract(value,'$.name')=?)";
      bindings.push(params.get("package"));
    }
    const bundleWhere={};
    for (const field of ["ecosystem","bundle_type"]) if (params.has(field))
      bundleWhere[field]={_eq:params.get(field)};
    let bundleFilter=this.where("bundle",bundleWhere,"b",bindings);
    if (params.has("source") || params.has("source_url")) {
      bundleFilter+=" AND "+col("b","source_fk")+" IN (SELECT value FROM json_each(?))";
      bindings.push(JSON.stringify(await this.sourceIds(params.get("source")??params.get("source_url"))));
    }
    if (params.has("channel")) {
      const aliases={any:"latest",latest:"latest",stable:"stable",dev:"dev",prerelease:"dev"};
      const channel=aliases[params.get("channel").trim().toLowerCase()];
      if (typeof channel!=="string") throw new CatalogError("Invalid channel");
      bundleFilter+=" AND EXISTS(SELECT 1 FROM json_each(b.data,'$.channels') WHERE value=?)";
      bindings.push(channel);
    }
    filter+=" AND EXISTS(SELECT 1 FROM catalog_records b WHERE b.kind='bundle' AND "+this.visible("b")+
      " AND "+col("b","id")+"="+col("r","bundle_fk")+" AND "+bundleFilter+")";
    const q=(params.get("q")??"").toLowerCase();
    if (q.length>512) throw new CatalogError("Search text too long");
    if (q && /^[\x00-\x7f]*$/.test(q)) {
      const text="COALESCE("+col("r","name")+",'')||' '||COALESCE("+col("r","description")+",'')";
      filter+=" AND (instr(lower("+text+"),?)>0 OR "+text+" GLOB '*[^ -~]*')";bindings.push(q);
    }
    const offset=Number(params.get("page_cursor")??0);
    if (!Number.isSafeInteger(offset) || offset<0) throw new CatalogError("Invalid patch cursor");
    const fields=["id","catalog_id","bundle_id","name","description","packages","metadata_status"];
    const projection="json_object("+fields.map(field=>"'"+field+"',"+col("r",field)).join(",")+")";
    const raw=(await this.db.prepare("SELECT "+projection+" AS data FROM catalog_records r WHERE r.kind=? AND "+
      this.visible("r")+" AND "+filter+" ORDER BY "+col("r","id")+" LIMIT 1001 OFFSET ?")
      .bind(...bindings,offset).all()).results;
    const rows=raw.slice(0,1000).map(item=>JSON.parse(item.data)).filter(row=>
      (!q || ((row.name??"")+" "+(row.description??"")).toLowerCase().includes(q)) &&
      (!params.has("app_version") || row.packages.some(pkg=>(!params.has("package") || pkg.name===params.get("package")) &&
        (!pkg.versions.length || pkg.versions.includes(params.get("app_version"))))))
      .map(row=>({...row,id:row.catalog_id,legacy_id:row.id}));
    return {rows,next_cursor:raw.length>1000?offset+1000:null,candidate_pages:1};
  }
  async decoratePatches(ids) {
    if (!ids.length) return [];
    const raw=(await this.db.prepare("SELECT r.data FROM catalog_records r WHERE r.kind='patch' AND "+
      this.visible("r")+" AND "+col("r","catalog_id")+" IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(ids)).all()).results;
    const rows=new Map(raw.map(item=>{const row=JSON.parse(item.data);return [row.catalog_id,row];}));
    const bundles=new Map();
    const result=[];
    for (const id of ids) {
      const row=rows.get(id);
      if (!bundles.has(row.bundle_id)) {
        const bundle=(await this.rows("bundle",{where:{catalog_id:{_eq:row.bundle_id}},limit:1}))[0];
        if (bundle) bundles.set(row.bundle_id,await this.restRow(bundle));
      }
      if (bundles.has(row.bundle_id)) result.push({...row,id,legacy_id:row.id,
        bundle:bundles.get(row.bundle_id),patch_packages:patchPackages({...row,id})});
    }
    return result;
  }
  async patchRows(args = {}) {
    if (args.q || args.reverse_pages || args.page_count && args.page_count !== 12)
      return super.patchRows(args);
    const bindings = ["patch"];
    let filter = this.visible("r") + " AND " +
      this.where("patch",this.publicFilter("patch",{}),"r",bindings);
    filter += " AND " + col("r","hidden") + " IS NOT 1 AND " + col("r","loader_excluded") + " IS NOT 1";
    const same = (field, value) => {
      bindings.push(value);
      filter += " AND " + col("r",field) + "=?";
    };
    const many = (field, values) => {
      if (values.length === 1) {
        same(field, values[0]);
      } else {
        bindings.push(JSON.stringify(values));
        filter += " AND " + col("r",field) + " IN (SELECT value FROM json_each(?))";
      }
    };
    if (args.bundle_id) same("bundle_id", args.bundle_id);
    if (args.bundle_ids) many("bundle_id", args.bundle_ids);
    if (args.patch_id != null) same("id", args.patch_id);
    if (args.patch_ids) many("id", args.patch_ids);
    if (!args.include_unverified) filter += " AND " + col("r","metadata_status") + "='verified'";
    if (args.package) {
      bindings.push(args.package);
      filter += " AND EXISTS(SELECT 1 FROM json_each(r.data,'$.packages') p" +
        " WHERE json_extract(p.value,'$.name')=?)";
    }
    const offset = Number(args.page_cursor ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new CatalogError("Invalid patch cursor");
    const maximum = args.all ? 5000 : Number(args.limit ?? 1000);
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 5000)
      throw new CatalogError("Invalid patch page size");
    const rows = (await this.db.prepare("SELECT r.data FROM catalog_records r WHERE r.kind=?" +
      " AND " + filter + " ORDER BY " + col("r","id") + " LIMIT ? OFFSET ?")
      .bind(...bindings,maximum+1,offset).all()).results.map(item=>JSON.parse(item.data));
    if (args.all && rows.length > maximum)
      throw new CatalogError("Query exceeds catalog budget; narrow the source or package filter",422);
    if (args.compact) {
      const data = rows.slice(0,maximum).map(row=>({...row,id:row.catalog_id,legacy_id:row.id}));
      return {rows:data,next_cursor:rows.length>maximum?offset+maximum:null,candidate_pages:1};
    }
    const sources = new Map();
    const bundles = args.bundle_rows ? new Map(args.bundle_rows.map(row=>[row.id,row])) : new Map();
    for (const row of rows.slice(0,maximum)) if (!bundles.has(row.bundle_id)) {
      const bundle = (await this.rows("bundle",{where:{catalog_id:{_eq:row.bundle_id}},limit:1}))[0];
      if (bundle) {
        if (!sources.has(bundle.catalog_id)) sources.set(bundle.catalog_id,await this.restRow(bundle));
        bundles.set(row.bundle_id,sources.get(bundle.catalog_id));
      }
    }
    const data = rows.slice(0,maximum).filter(row=>bundles.has(row.bundle_id))
      .map(row=>({...row,id:row.catalog_id,legacy_id:row.id,bundle:bundles.get(row.bundle_id),patch_packages:patchPackages({...row,id:row.catalog_id})}));
    return {rows:data,next_cursor:rows.length>maximum?offset+maximum:null,candidate_pages:1};
  }
  async restRows(rows) {
    const ids=[...new Set(rows.filter(row=>row.__kind==="bundle").map(row=>row.source_fk))];
    const sources=new Map();
    // Stay below the filter binding limit and avoid one D1 query per bundle.
    for (let offset=0;offset<ids.length;offset+=80)
      for (const source of await this.rows("source",{where:{id:{_in:ids.slice(offset,offset+80)}},limit:80}))
        sources.set(source.id,source);
    return Promise.all(rows.map(row=>this.restRow(row,sources)));
  }
  async restRow(row, sources = null) {
    const { __kind, __archived, catalog_id, ...result } = row;
    if (catalog_id) { result.legacy_id = row.id; result.id = catalog_id; }
    if (__kind === "bundle") {
      const source = sources ? sources.get(row.source_fk) :
        (await this.rows("source", {where:{id:{_eq:row.source_fk}},limit:1}))[0];
      result.source = source ? await this.restRow(source) : null;
      Object.assign(result, bundleImages(result));
    }
    return result;
  }
  async historyDocument(id, args = {}) {
    const offset = Number(args.offset ?? 0), limit = Number(args.limit ?? 65536);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) ||
        limit < 1 || limit > 65536) throw new CatalogError("Invalid document byte range");
    const row = (await this.rows("history_release",{where:{id:{_eq:id}},limit:1}))[0];
    if (!row) throw new CatalogError("Release not found",404);
    let bytes, total;
    if (row.document_key) {
      const key = "objects/"+row.document_key;
      const metadata = await this.env.ARCHIVE.head(key);
      if (!metadata) throw new CatalogError("Release document unavailable",503);
      total = metadata.size;
      if (offset >= total) bytes = new Uint8Array();
      else {
        const object = await this.env.ARCHIVE.get(key,{range:{offset,length:limit}});
        if (!object) throw new CatalogError("Release document unavailable",503);
        bytes = new Uint8Array(await object.arrayBuffer());
      }
    } else {
      delete row.__kind;
      delete row.__archived;
      const body = new TextEncoder().encode(JSON.stringify(row));
      bytes = body.slice(offset,offset+limit);
      total = body.length;
    }
    let binary = "";
    for (let i=0;i<bytes.length;i+=8192)
      binary += String.fromCharCode(...bytes.slice(i,i+8192));
    return {encoding:"base64",data:btoa(binary),total_bytes:total,
      next_offset:offset+bytes.length < total ? offset+bytes.length : null};
  }
  async history(args = {}) {
    const limit = Number(args.limit ?? 25);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new CatalogError("limit must be 1–100");
    const where = {};
    for (const key of ["source_id", "version", "availability", "id"])
      if (args[key] != null) where[key] = {_eq:args[key]};

    if (args.prerelease != null) where.is_prerelease = {_eq:args.prerelease === true || args.prerelease === "true"};
    const bindings = ["history_release"];
    let filter = this.where("history_release",where,"r",bindings);
    if (args.source) {
      bindings.push(normalizeSource(args.source).toLowerCase());
      filter += " AND LOWER("+col("r","source_url")+")=?";
    }
    const date = "COALESCE(julianday("+col("r","published_at")+"),0)";
    const direction = args.order === "desc" ? "DESC" : "ASC";
    if (args.order && !["asc","desc"].includes(args.order)) throw new CatalogError("Invalid order");
    let cursor = null;
    if (args.after) {
      try { cursor = JSON.parse(atob(args.after)); }
      catch { throw new CatalogError("Invalid history cursor"); }
      if (!Array.isArray(cursor) || cursor.length !== 3 || cursor[0] !== this.manifest.generation)
        throw new CatalogError("Catalog changed; restart history pagination",409);
      if (typeof cursor[1] !== "number" || !Number.isFinite(cursor[1]) || typeof cursor[2] !== "string")
        throw new CatalogError("Invalid history cursor");
      bindings.push(cursor[1], cursor[1], cursor[2]);
      const op = direction === "ASC" ? ">" : "<";
      filter += " AND (" + date + op + "? OR (" + date + "=? AND r.record_key" + op + "?))";
    }
    for (const [name, op] of [["from",">="],["to","<="]]) if (args[name]) {
      if (!/^\d{4}-\d{2}-\d{2}/.test(args[name]) || !Number.isFinite(Date.parse(args[name])))
        throw new CatalogError("Invalid publication date bound");
      bindings.push(args[name]); filter += " AND " + date + op + "julianday(?)";
    }
    if (args.runtime) {
      bindings.push(args.runtime);
      filter += " AND EXISTS(SELECT 1 FROM json_each(r.data,'$.runtimes') WHERE value=?)";
    }
    if (args.bundle_id) {
      bindings.push(args.bundle_id);
      filter += " AND EXISTS(SELECT 1 FROM json_each(r.data,'$.bundle_ids') WHERE value=?)";
    }
    const query = "SELECT r.data," + date + " AS sort_date FROM catalog_records r WHERE r.kind=? AND " + this.visible("r") +
      " AND " + filter + " ORDER BY " + date + " " + direction + ",r.record_key " + direction + " LIMIT ?";
    const result = (await this.db.prepare(query).bind(...bindings, limit + 1).all()).results;
    const rows = result.map(item => JSON.parse(item.data));
    const more = rows.length > limit;
    const data = rows.slice(0,limit).map(row=>{ const {document_key,...publicRow}=row; return publicRow; });
    const last = data.at(-1);
    return {data, generation:this.manifest.generation, next_cursor:more ?
      btoa(JSON.stringify([this.manifest.generation,result[limit-1].sort_date,last.id])) : null};
  }
  async historicalField(source,args,info) {
    const aggregate = info.fieldName.endsWith("_aggregate");
    const relation = relations[source.__kind]?.[aggregate ? info.fieldName.slice(0,-10) : info.fieldName];
    if (!relation) return {handled:false};
    const [kind,parentKey,childKey] = relation;
    args = {...args,include_archived:true};
    const extra = {field:childKey,value:source[parentKey]};
    if (aggregate) return {handled:true,value:{aggregate:{count:countArgs=>this.count(kind,args,extra,countArgs)},
      nodes:()=>this.rows(kind,args,extra)}};
    const rows = await this.rows(kind,args,extra);
    return {handled:true,value:getNamedType(info.returnType).name === kind &&
      !String(info.returnType).includes("[") ? rows[0] ?? null : rows};
  }
  async graph(schema, document, operation, variables, payload) {
    // Validate the complete executed query before any I/O so fallback never mixes plans.
    let supported = true;
    const typeInfo = new TypeInfo(schema);
    visit(document, visitWithTypeInfo(typeInfo, { Field: node => {
      const field = node.name.value;
      for (const directive of node.directives ?? []) {
        const value = directive.arguments?.find(arg=>arg.name.value==="if");
        const condition = value && valueFromASTUntyped(value.value,variables);
        if ((directive.name.value==="skip" && condition===true) ||
            (directive.name.value==="include" && condition===false)) return false;
      }
      if (field.endsWith("_stream") || field === "refresh_jobs" ||
          ["min","max","sum","avg","stddev","variance","stddev_pop","stddev_samp","var_pop","var_samp"].includes(field)) supported = false;
      for (const arg of node.arguments ?? []) {
        const value = valueFromASTUntyped(arg.value, variables);
        try {
          if (arg.name.value === "where") {
            const argType = typeInfo.getFieldDef()?.args.find(item=>item.name==="where")?.type;
            const bindings = [];
            this.where(getNamedType(argType).name.replace(/_bool_exp$/,""),value,"r",bindings);
            // Reserve room for kind, visibility and a parent relationship binding.
            if (bindings.length > 90) supported = false;
          }
          if (arg.name.value === "order_by") this.order({order_by:value});
          if (["distinct_on","q","package_name","bundle_id"].includes(arg.name.value) &&
              value != null && (!Array.isArray(value) || value.length)) supported = false;
        } catch (error) { if (error instanceof Unsupported) supported = false; else throw error; }
      }
    }}));
    if (!supported) return null;
    return execute({schema, document, variableValues:variables, operationName:payload.operationName,
      fieldResolver: async (source, args, context, info) => {
        if (["query_root","subscription_root"].includes(info.parentType.name)) {
          let kind = info.fieldName === "release" ? "bundle" : info.fieldName;
          if (kind === "catalog_generation") return this.manifest.generation;
          if (kind === "historical_releases") return this.history(args);
          if (kind === "historical_release") return (await this.history({id:args.id,limit:1})).data[0] ?? null;
          if (kind === "historical_apps") return (await this.rows("app",{...args,include_archived:true})).map(({__kind,__archived,...row})=>row);
          if (kind === "historical_sources") return (await this.rows("history_source", args));
          if (["historical_bundles","historical_patches","historical_packages","historical_patch_packages"].includes(kind)) {
            kind = {historical_bundles:"bundle",historical_patches:"patch",
              historical_packages:"package",historical_patch_packages:"patch_package"}[kind];
            return this.rows(kind,{...args,include_archived:true});
          }
          if (kind.endsWith("_by_pk")) {
            kind = kind.slice(0,-6);
            const where = Object.fromEntries(Object.entries(args).map(([key,value])=>[key,{_eq:value}]));
            return (await this.rows(kind,{where,limit:1}))[0] ?? null;
          }
          if (kind.endsWith("_aggregate")) {
            kind = kind.slice(0,-10);
            return {aggregate:{count:countArgs=>this.count(kind,args,null,countArgs)},
              nodes:()=>this.rows(kind,args)};
          }
          if (!kinds.has(kind)) return undefined;
          return this.rows(kind,args);
        }
        const aggregateRelation = info.fieldName.endsWith("_aggregate");
        const relation = relations[source?.__kind]?.[aggregateRelation ?
          info.fieldName.slice(0,-10) : info.fieldName];
        if (relation) {
          const [kind, parentKey, childKey] = relation;
          args = {...args,include_archived:source.__archived};
          const extra = {field:childKey,value:source[parentKey]};
          if (aggregateRelation) return {aggregate:{count:countArgs=>this.count(kind,args,extra,countArgs)},
            nodes:()=>this.rows(kind,args,extra)};
          const rows = await this.rows(kind,args,extra);
          return getNamedType(info.returnType).name === kind &&
            !String(info.returnType).includes("[") ? rows[0] ?? null : rows;
        }
        if (info.parentType.name === "historical_release" && info.fieldName === "document")
          return this.historyDocument(source.id,args);
        if (source?.__kind === "bundle" && ["icon_url","owner_avatar_url"].includes(info.fieldName))
          return (await this.restRow(source))[info.fieldName];
        const value = source?.[info.fieldName];
        return typeof value === "function" ? value(args) : value;
      }
    });
  }
}
