import { Catalog, CatalogError, pagination } from "./catalog.js";

// Allow the manifest read to span a short publication outage. Other reads
// retain the tighter retry budget so parallel bundle pages do not pile up.
const manifestRetryDelays = [1000, 3000, 7000];
const pageRetryDelays = [200, 400];

async function fetchCatalog(url, options) {
  const isManifest = new URL(url).pathname === "/catalog/data/manifest.json";
  const delays = isManifest ? manifestRetryDelays : pageRetryDelays;
  const maxRetryAfter = isManifest ? 12000 : 5000;
  for (let attempt=0; ; attempt++) {
    let response;
    try { response=await fetch(url,options); }
    catch (error) {
      if (attempt>=delays.length || !(error instanceof TypeError || error.name==="TimeoutError")) throw error;
    }
    if (response && (![408,429,500,502,503,504].includes(response.status) || attempt>=delays.length)) return response;
    let delay=delays[attempt];
    const retryAfter=response?.headers.get("Retry-After");
    if (retryAfter) {
      const seconds=Number(retryAfter);
      const requested=Number.isFinite(seconds) ? seconds*1000 : Date.parse(retryAfter)-Date.now();
      // Do not retry earlier than a long server-requested cooldown.
      if (requested>maxRetryAfter) return response;
      if (Number.isFinite(requested)) delay=Math.max(delay,requested);
    }
    await response?.body?.cancel().catch(()=>{});
    await new Promise(resolve=>setTimeout(resolve,delay+(isManifest ? Math.random()*250 : 0)));
  }
}

// Bootstrap only current bundles; source history is requested when the source is selected.
export class ApiCatalog extends Catalog {
  constructor(api) {
    super(api.replace(/\/$/,"") + "/catalog/data/",fetchCatalog,false);
    this.api = api.replace(/\/$/,"");
    this.bundleRows = [];
    this.histories = new Map();
  }
  async bundlePages(source = null) {
    const rows = [];
    let offset = 0, limit = 100;
    const read = async (start, size, partial = false) => {
      const params = new URLSearchParams({limit:String(size),offset:String(start),
        generation:this.manifest.generation});
      if (source) params.set("source",source);
      const response = await this.fetcher(this.api + "/catalog/bundles?" + params);
      if (response.status === 422 && size > 1) {
        const left = Math.ceil(size / 2);
        if (partial) return read(start,left,true);
        const first = await read(start,left);
        if (first.data.length < left) return first;
        const second = await read(start+left,size-left);
        return {...first,data:[...first.data,...second.data]};
      }
      if (!response.ok) {
        const error = new CatalogError("Catalog changed or unavailable; reload the page",response.status);
        error.generationUnavailable = response.status === 409;
        throw error;
      }
      const page = await response.json();
      if (!Array.isArray(page.data) || page.data.length > size)
        throw new CatalogError("Invalid bundle pagination response",502);
      return {...page,pageLimit:size};
    };
    const first = await read(0,limit,true);
    limit = first.pageLimit;
    if (Number.isSafeInteger(first.total) && first.total >= first.data.length) {
      const pages = new Map([[0,first.data]]);
      let next = first.data.length;
      if (!next && first.total) throw new CatalogError("Invalid bundle pagination response",502);
      let failed = false;
      const worker = async () => {
        while (!failed && next < first.total) {
          const start = next, size = Math.min(limit,first.total-start);
          next += size;
          try {
            const page = await read(start,size);
            if (page.total !== first.total || page.data.length !== size)
              throw new CatalogError("Invalid bundle pagination response",502);
            pages.set(start,page.data);
          } catch (error) { failed = true;throw error; }
        }
      };
      await Promise.all(Array.from({length:Math.min(3,Math.ceil((first.total-next)/limit))},worker));
      return [...pages].sort((a,b)=>a[0]-b[0]).flatMap(([,data])=>data);
    }
    rows.push(...first.data);
    if (first.data.length < limit) return rows;
    offset = first.data.length;
    // Older API deployments do not expose a total; retain sequential pagination.
    while (true) {
      const params = new URLSearchParams({limit:String(limit),offset:String(offset),
        generation:this.manifest.generation});
      if (source) params.set("source",source);
      const response = await this.fetcher(this.api + "/catalog/bundles?" + params);
      if (response.status === 422 && limit > 1) {
        limit = Math.ceil(limit / 2);
        continue;
      }
      if (!response.ok) {
        const error = new CatalogError("Catalog changed or unavailable; reload the page",response.status);
        error.generationUnavailable = response.status === 409;
        throw error;
      }
      const page = await response.json();
      rows.push(...page.data);
      if (page.data.length < limit) break;
      offset += page.data.length;
    }
    return rows;
  }
  async file(name) {
    const match = name.match(/^bundles\/([a-f0-9]+)\.json$/);
    if (!match) return super.file(name);
    if (!this.loaded.has(name)) this.loaded.set(name,(async()=>{
      const response=await this.fetcher(this.api+"/bundles/"+match[1]);
      if (!response.ok) {
        const detail=await response.json().catch(()=>({}));
        const error=new CatalogError(detail?.error || "Unable to load bundle; retry",response.status);
        const generation=response.headers.get("X-Catalog-Generation");
        error.generationUnavailable=response.status===409 ||
          Boolean(generation && generation!==this.manifest.generation);
        throw error;
      }
      if (response.headers.get("X-Catalog-Generation") !== this.manifest.generation) {
        const error=new CatalogError("Catalog generation unavailable",409);
        error.generationUnavailable=true;
        throw error;
      }
      return response.json();
    })());
    try { return await this.loaded.get(name); }
    catch (error) { this.loaded.delete(name); throw error; }
  }
  async patchRows(args = {}) {
    if (!args.bundle_id || args.q) return super.patchRows(args);
    const rows=[];
    let cursor=args.page_cursor ?? 0;
    let {limit}=pagination({limit:args.limit ?? 100});
    do {
      const params=new URLSearchParams({bundle_id:args.bundle_id,generation:this.manifest.generation,
        page_cursor:String(cursor),limit:String(limit),
        include_unverified:String(Boolean(args.include_unverified))});
      if (args.compact) params.set("compact","true");
      if (args.package) params.set("package",args.package);
      const response=await this.fetcher(this.api+"/catalog/patches?"+params);
      if (!response.ok) {
        const detail=(await response.json().catch(()=>({}))) ?? {};
        const oversized=response.status===422 && (detail.code==="response_too_large" ||
          /^Response too large/.test(detail.error ?? ""));
        if (oversized && limit>1) {
          limit=Math.ceil(limit/2);
          continue;
        }
        const message=response.status===409 ? "Catalog changed; reload the page" :
          oversized ? "Patch metadata response exceeds the API size limit" :
          detail.error || "Unable to load patches; retry";
        const error = new CatalogError(message,response.status);
        error.generationUnavailable = response.status === 409;
        throw error;
      }
      const page=await response.json();
      if (!Array.isArray(page.rows) || (page.next_cursor!==null &&
          (!Number.isSafeInteger(page.next_cursor) || page.next_cursor<=Number(cursor) || !page.rows.length)))
        throw new CatalogError("Invalid patch pagination response",502);
      rows.push(...page.rows);cursor=page.next_cursor;
      if (!args.all) return {...page,rows};
    } while(cursor !== null);
    return {rows,next_cursor:null,candidate_pages:1};
  }
  async bundles({sources = []} = {}) {
    if (!this.bootstrap) this.bootstrap = this.bundlePages().then(rows=>{
      this.bundleRows = [...new Map([...rows,...this.bundleRows].map(row=>[row.id,row])).values()];
    }).catch(error=>{this.bootstrap = null;throw error;});
    await this.bootstrap;
    for (const source of new Set(sources)) await this.historyBundles(source);
    return this.bundleRows;
  }
  async historyBundles(source) {
    if (!this.histories.has(source)) this.histories.set(source,(async()=>{
      const rows = await this.bundlePages(source);
      const merged = new Map(this.bundleRows.map(row=>[row.id,row]));
      for (const row of rows) merged.set(row.id,row);
      this.bundleRows = [...merged.values()];
      return rows;
    })().catch(error=>{this.histories.delete(source);throw error;}));
    return this.histories.get(source);
  }
}
