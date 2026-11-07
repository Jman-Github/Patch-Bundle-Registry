import {CatalogError, canonicalBundleType, selectRows} from "../../shared/catalog.js";
import {latestReleaseIds} from "../../shared/site.js";

// App browsing reads filtered D1 relationships, never the full R2 bundle/app indexes.
export async function browseApps(catalog, params, args, packageName = null, bundlesOnly = false) {
  const release = params.get("release") ?? "all";
  if (!["all","latest","release","prerelease"].includes(release))
    throw new CatalogError("release must be all, latest, release, or prerelease");
  const q = params.get("q") ?? "", packageQuery = params.get("package") ?? "", version = params.get("app_version") ?? "";
  if ([q,packageQuery,version].some(value=>value.length>512)) throw new CatalogError("Search text too long");
  const bindings = [];
  let filter = catalog.visible("a") + " AND " + catalog.visible("b") + " AND " + catalog.visible("s") +
    " AND json_extract(s.data,'$.enabled')=1"+
    " AND COALESCE(json_extract(b.data,'$.availability'),'available')<>'unavailable'";
  const equal = (expression,value) => {filter+=" AND "+expression+"=?";bindings.push(value);};
  if (packageName !== null) equal("a.record_key",packageName);
  for (const field of ["ecosystem","bundle_type","version","metadata_status"]) if (params.has(field))
    equal("json_extract(b.data,'$."+field+"')",field==="bundle_type"?canonicalBundleType(params.get(field)):params.get(field));
  if (params.get("include_unverified") !== "true") equal("json_extract(b.data,'$.metadata_status')","verified");
  if (release === "latest") {
    const fields=["catalog_id","source_id","created_at","channels","is_latest"];
    const projection="json_object("+fields.map(field=>"'"+field+"',json_extract(data,'$."+field+"')").join(",")+")";
    const candidates=(await catalog.db.prepare("SELECT "+projection+" AS data FROM catalog_records n WHERE kind='bundle' AND "+
      catalog.visible("n")+" AND json_extract(data,'$.is_latest')=1 ORDER BY record_key").all()).results
      .map(item=>{const row=JSON.parse(item.data);return {...row,id:row.catalog_id};});
    filter+=" AND b.record_key IN (SELECT value FROM json_each(?))";
    bindings.push(JSON.stringify([...latestReleaseIds(candidates)]));
  }
  if (release === "release" || release === "prerelease") equal("json_extract(b.data,'$.is_prerelease')",Number(release==="prerelease"));
  if (params.has("source") || params.has("source_url")) {
    filter+=" AND json_extract(b.data,'$.source_fk') IN (SELECT value FROM json_each(?))";
    bindings.push(JSON.stringify(await catalog.sourceIds(params.get("source")??params.get("source_url"))));
  }
  if (params.has("channel")) {
    const channel={any:"latest",latest:"latest",stable:"stable",prerelease:"dev",dev:"dev"}[params.get("channel").trim().toLowerCase()];
    if (typeof channel!=="string") throw new CatalogError("Invalid channel");
    filter+=" AND EXISTS(SELECT 1 FROM json_each(b.data,'$.channels') WHERE value=?)";bindings.push(channel);
  }
  if (version) {
    filter+=" AND (json_extract(ref.value,'$.unrestricted')=1 OR EXISTS("+
      "SELECT 1 FROM json_each(ref.value,'$.versions') WHERE value=?))";bindings.push(version);
  }
  for (const term of q.toLowerCase().trim().split(/\s+/).filter(Boolean)) {
    if (!/^[\x00-\x7f]*$/.test(term)) continue;
    const text="COALESCE(json_extract(a.data,'$.app_name'),'')||' '||json_extract(a.data,'$.package_name')";
    filter+=" AND (instr(lower("+text+"),?)>0 OR "+text+" GLOB '*[^ -~]*')";
    bindings.push(term);
  }
  // SQL lower() is ASCII-only. Version matching below uses exact JS semantics
  // through a bounded projection whenever a package/version query is supplied.
  const links = "SELECT a.record_key AS app_key,json_extract(a.data,'$.package_name') AS package_name,"+
    "json_extract(a.data,'$.app_name') AS app_name,json_extract(a.data,'$.icon_url') AS icon_url,"+
    "json_extract(a.data,'$.metadata_source') AS metadata_source,ref.value AS reference,"+
    "json_extract(b.data,'$.source_id') AS source_id,json_extract(b.data,'$.metadata_status') AS metadata_status "+
    // Keep json_each before its keyed joins: reordering b before ref scans every
    // bundle for every app and times out once the historical catalog grows.
    "FROM catalog_records a CROSS JOIN json_each(a.data,'$.bundles') ref "+
    "CROSS JOIN catalog_records b ON b.kind='bundle' AND b.record_key=json_extract(ref.value,'$.bundle_id') "+
    "CROSS JOIN catalog_records s ON s.kind='source' AND s.record_key=json_extract(b.data,'$.source_id') "+
    "WHERE a.kind='app' AND "+filter;
  const terms=q.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const [packagePart,exactVersion]=packageQuery.toLowerCase().split("@",2);
  let summaries;
  if (packageQuery || bundlesOnly) {
    const rows=(await catalog.db.prepare("WITH links AS ("+links+") SELECT * FROM links ORDER BY app_key")
      .bind(...bindings).all()).results;
    const grouped=new Map();
    for (const row of rows) {
      const reference=JSON.parse(row.reference), nameMatches=row.package_name.toLowerCase().includes(packagePart);
      const versions=reference.versions??[];
      if (packageQuery && !(exactVersion!==undefined ? nameMatches &&
        (!exactVersion || reference.unrestricted || versions.some(v=>String(v).toLowerCase()===exactVersion)) :
        nameMatches || versions.some(v=>String(v).toLowerCase().includes(packagePart)))) continue;
      if (!grouped.has(row.app_key)) grouped.set(row.app_key,{...row,references:[]});
      grouped.get(row.app_key).references.push({...reference,source_id:row.source_id,metadata_status:row.metadata_status});
    }
    summaries=[...grouped.values()].map(row=>({...row,
      bundle_count:row.references.length, source_count:new Set(row.references.map(r=>r.source_id)).size,
      patch_count:row.references.some(r=>r.compatibility_unknown)?null:row.references.reduce((n,r)=>n+r.patch_count,0),
      versions:[...new Set(row.references.flatMap(r=>r.versions))].sort(), unrestricted:row.references.some(r=>r.unrestricted)}));
  } else {
    // Collapse large historical relationship arrays inside SQLite before returning rows.
    const sql="WITH links AS ("+links+") SELECT app_key,package_name,app_name,icon_url,metadata_source,"+
      "COUNT(*) AS bundle_count,COUNT(DISTINCT source_id) AS source_count,"+
      "CASE WHEN MAX(COALESCE(json_extract(reference,'$.compatibility_unknown'),0)) THEN NULL "+
      "ELSE SUM(json_extract(reference,'$.patch_count')) END AS patch_count,"+
      "MAX(COALESCE(json_extract(reference,'$.unrestricted'),0)) AS unrestricted,"+
      "(SELECT json_group_array(value) FROM (SELECT DISTINCT v.value FROM links l,json_each(l.reference,'$.versions') v "+
      "WHERE l.app_key=links.app_key)) AS versions FROM links GROUP BY app_key";
    summaries=(await catalog.db.prepare(sql).bind(...bindings).all()).results.map(row=>({...row,versions:JSON.parse(row.versions).sort(),unrestricted:Boolean(row.unrestricted)}));
  }
  summaries=summaries.filter(row=>/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(row.package_name) &&
    terms.every(term=>(row.app_name+" "+row.package_name).toLowerCase().includes(term)))
    .sort((a,b)=>a.app_name.localeCompare(b.app_name)||a.package_name.localeCompare(b.package_name));
  const clean=row=>{const {app_key,reference,references,source_id,metadata_status,...rest}=row;return rest;};
  if (packageName !== null) {
    const app=summaries[0];
    if (!app) throw new CatalogError("App not found",404);
    if (!bundlesOnly) return {...clean(app),bundles_url:"/apps/"+encodeURIComponent(packageName)+"/bundles",
      patches_url:"/apps/"+encodeURIComponent(packageName)+"/patches"};
    const references=new Map(app.references.map(row=>[row.bundle_id,row]));
    const ids=[...references.keys()];
    // Sort only scalar release fields, and fetch complete records for the selected page.
    const fields=["catalog_id","version","created_at","patch_count"];
    const projection="json_object("+fields.map(field=>"'"+field+"',json_extract(data,'$."+field+"')").join(",")+")";
    const candidates=(await catalog.db.prepare("SELECT "+projection+" AS data FROM catalog_records b WHERE kind='bundle' AND "+
      catalog.visible("b")+" AND json_extract(data,'$.catalog_id') IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(ids)).all()).results.map(item=>{const row=JSON.parse(item.data);return {...row,id:row.catalog_id};});
    const page=selectRows(candidates,args);
    // Hydrate the selected page with one bundle batch and one source batch.
    const bundles=await catalog.hydratedBundles(page.data.map(row=>row.id));
    page.data=page.data.map(row=>{
      const bundle=bundles.get(row.id);
      if (!bundle) throw new CatalogError("Bundle not found",503);
      const {source_id,...compatibility}=references.get(row.id);
      return {...bundle,app_compatibility:compatibility};
    });
    return page;
  }
  return selectRows(summaries.map(clean),args);
}
