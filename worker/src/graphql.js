/* Independent implementation of the upstream read-only Hasura public role.
 * Reference: https://github.com/brosssh/revanced-external-bundles/blob/3a59398d667c83cd7033f859f3cb59237da92b3f/src/main/resources/hasura/metadata.json
 * No upstream backend source is incorporated. See docs/source-attribution.md.
 */
import {
  buildSchema, execute, getNamedType, getOperationAST, getVariableValues,
  isListType, isNonNullType, parse, validate, valueFromASTUntyped, visit
} from "graphql";
import site from "../../config/site.json" with {type:"json"};
import { AsyncLocalStorage } from "node:async_hooks";
import { createPostgresMatcher } from "./postgres-regex.js";
import { mergeJobs } from "./jobs.js";
import { createPostgresComparator } from "../../shared/postgres-collation.js";
import { streamArguments, streamBatch } from "./streaming.js";
import { bundleImages, CatalogError, compareValues, configureAggregateMatcher, configureCaseFolder, configureRegexMatcher, configureTextComparator, filterResult, matches, pagination, selectRows } from "../../shared/catalog.js";

const regexContext = new AsyncLocalStorage();
const validatedQueries = new Map();
const MAX_VALIDATED_QUERIES = 64;
const defaultComparator = createPostgresComparator(site.postgres_locale ?? "en_US.utf8");
configureTextComparator((left,right) => (regexContext.getStore()?.compare ?? defaultComparator)(left,right));
configureRegexMatcher((value, pattern, operator) =>
  (regexContext.getStore() ?? createPostgresMatcher())(value, pattern, operator));
configureCaseFolder(value => (regexContext.getStore() ?? createPostgresMatcher()).fold(value));

const definitions = {
  source: { id: "Int", catalog_id: "String", url: "String", enabled: "Boolean",
    unavailable_reason: "String", host: "String", namespace: "String", repo: "String" },
  source_metadata: { id: "Int", source_fk: "Int", owner_name: "String", repo_name: "String",
    owner_avatar_url: "String", bundle_icon_url: "String", repo_description: "String", repo_stars: "Int",
    repo_pushed_at: "String", is_repo_archived: "Boolean" },
  bundle: { id: "Int", catalog_id: "String", source_fk: "Int", source_id: "String",
    bundle_type: "String", ecosystem: "String", version: "String", created_at: "String",
    description: "String", download_url: "String", signature_download_url: "String",
    file_hash: "String", icon_url: "String", owner_avatar_url: "String",
    is_prerelease: "Boolean", is_latest: "Boolean",
    need_patches_update: "Boolean", patcher_failure_fingerprint: "String",
    metadata_status: "String", patcher_runtime: "String", extraction_status: "String",
    patch_count: "Int", release_status: "String" },
  patch: { id: "Int", catalog_id: "String", bundle_fk: "Int", bundle_id: "String",
    source_id: "String", name: "String", description: "String", use: "Boolean", hidden: "Boolean",
    metadata_status: "String", patch_metadata_version: "String" },
  package: { id: "Int", name: "String", version: "String", app_name: "String", icon_url: "String" },
  patch_package: { package_fk: "Int", patch_fk: "Int", patch_id: "String" },
  refresh_jobs: { id: "Int", job_id: "String", job_type: "String", status: "String",
    error: "String", completed_at: "timestamptz", started_at: "timestamptz" }
};
// Omitted optional JSON fields have SQL NULL semantics in the public schema.
const scalarDefaults = Object.fromEntries(Object.entries(definitions).map(([kind, fields]) =>
  [kind, Object.fromEntries(Object.keys(fields).map(field => [field, null]))]));
function graphRow(kind, row) { return { ...scalarDefaults[kind], ...row, __kind: kind }; }

const objects = {
  source: { source_metadatum: "source_metadata" }, source_metadata: { source: "source" },
  bundle: { source: "source" }, patch: { bundle: "bundle" },
  patch_package: { package: "package", patch: "patch" }
};
const arrays = {
  source: { bundles: "bundle" }, bundle: { patches: "patch" },
  patch: { patch_packages: "patch_package" }, package: { patch_packages: "patch_package" }
};
const numericOperations = ["avg", "sum", "stddev", "stddev_pop", "stddev_samp",
  "variance", "var_pop", "var_samp"];
const scalarComparisons = ["String", "Int", "Float", "Boolean", "timestamptz"].map(type => {
  const text = type === "String" ? `
    _like: String, _ilike: String, _nlike: String, _nilike: String,
    _regex: String, _iregex: String, _nregex: String, _niregex: String,
    _similar: String, _nsimilar: String` : "";
  return `input ${type}_comparison_exp {
    _eq: ${type}, _neq: ${type}, _in: [${type}!], _nin: [${type}!],
    _is_null: Boolean, _gt: ${type}, _gte: ${type}, _lt: ${type}, _lte: ${type} ${text}
  }`;
}).join("\n");
const argsFor = name => `where: ${name}_bool_exp, order_by: [${name}_order_by!],
  limit: Int, offset: Int, distinct_on: [${name}_select_column!]`;
function schemaFor(name, fields) {
  const scalars = Object.entries(fields);
  const orderable = scalars.filter(([, type]) => type !== "Boolean");
  const numeric = scalars.filter(([, type]) => type === "Int");
  const booleans = scalars.filter(([, type]) => type === "Boolean");
  const objectFields = Object.entries(objects[name] ?? {});
  const arrayFields = Object.entries(arrays[name] ?? {});
  const extras = name === "bundle" ? "channels: [String!]!, import_urls: jsonb, release_url: String" :
    name === "patch" ? "options: jsonb, dependencies: [String!], compatiblePackages: jsonb" :
    name === "package" ? "versions: [String!]" : "";
  const aggregateDefs = ["min", "max", ...numericOperations].map(op => {
    const entries = op === "min" || op === "max" ? orderable : numeric;
    return entries.length ? `type ${name}_${op}_fields {
      ${entries.map(([key, type]) => key + ": " +
        (op === "sum" ? "bigint" : numericOperations.includes(op) ? "Float" : type)).join("\n")}
    }` : "";
  }).join("\n");
  const aggregateFields = ["min", "max", ...numericOperations].filter(op =>
    (op === "min" || op === "max" ? orderable : numeric).length)
    .map(op => `${op}: ${name}_${op}_fields`).join("\n");
  return `
    type ${name} {
      ${scalars.map(([key, type]) => key + ": " + type).join("\n")}
      ${objectFields.map(([key, type]) => key + ": " + type).join("\n")}
      ${arrayFields.map(([key, type]) => `${key}(${argsFor(type)}): [${type}!]!
        ${key}_aggregate(${argsFor(type)}): ${type}_aggregate!`).join("\n")}
      ${extras}
    }
    input ${name}_bool_exp {
      _and: [${name}_bool_exp!], _or: [${name}_bool_exp!], _not: ${name}_bool_exp
      ${scalars.map(([key, type]) => key + ": " + type + "_comparison_exp").join("\n")}
      ${[...objectFields, ...arrayFields].map(([key, type]) => key + ": " + type + "_bool_exp").join("\n")}
      ${arrayFields.map(([key, type]) => key + "_aggregate: " + type + "_aggregate_bool_exp").join("\n")}
    }
    input ${name}_order_by {
      ${scalars.map(([key]) => key + ": order_by").join("\n")}
      ${objectFields.map(([key, type]) => key + ": " + type + "_order_by").join("\n")}
      ${arrayFields.map(([key, type]) => key + "_aggregate: " + type + "_aggregate_order_by").join("\n")}
    }
    enum ${name}_select_column { ${scalars.map(([key]) => key).join(" ")} }
    ${aggregateDefs}
    input ${name}_aggregate_bool_exp {
      count: ${name}_aggregate_bool_exp_count
      ${booleans.length ? ["bool_and", "bool_or"].map(op =>
        op + ": " + name + "_aggregate_bool_exp_" + op).join("\n") : ""}
      ${numeric.length ? ["min", "max", ...numericOperations].map(op =>
        op + ": " + name + "_aggregate_bool_exp_" + op).join("\n") : ""}
    }
    ${booleans.length ? ["bool_and", "bool_or"].map(op => `
      enum ${name}_select_column_${name}_aggregate_bool_exp_${op}_arguments_columns {
        ${booleans.map(([key]) => key).join(" ")}
      }
      input ${name}_aggregate_bool_exp_${op} {
        arguments: ${name}_select_column_${name}_aggregate_bool_exp_${op}_arguments_columns!,
        distinct: Boolean, filter: ${name}_bool_exp, predicate: Boolean_comparison_exp!
      }`).join("\n") : ""}
    input ${name}_aggregate_bool_exp_count {
      arguments: [${name}_select_column!], distinct: Boolean,
      filter: ${name}_bool_exp, predicate: Int_comparison_exp!
    }
    ${numeric.length ? `enum ${name}_numeric_column { ${numeric.map(([key]) => key).join(" ")} }` : ""}
    ${numeric.length ? ["min", "max", ...numericOperations].map(op =>
      `input ${name}_aggregate_bool_exp_${op} {
        arguments: ${name}_numeric_column!, distinct: Boolean,
        filter: ${name}_bool_exp, predicate: Float_comparison_exp!
      }`).join("\n") : ""}
    type ${name}_aggregate_fields {
      count(columns: [${name}_select_column!], distinct: Boolean): Int!
      ${aggregateFields}
    }
    type ${name}_aggregate { aggregate: ${name}_aggregate_fields, nodes: [${name}!]! }
    input ${name}_aggregate_order_by {
      count: order_by
      ${["min", "max", ...numericOperations].filter(op =>
        (op === "min" || op === "max" ? orderable : numeric).length)
        .map(op => op + ": " + name + "_" + op + "_order_by").join("\n")}
    }
    ${["min", "max", ...numericOperations].map(op => {
      const entries = op === "min" || op === "max" ? orderable : numeric;
      return entries.length ? `input ${name}_${op}_order_by {
        ${entries.map(([key]) => key + ": order_by").join("\n")}
      }` : "";
    }).join("\n")}
  `;
}
const roots = Object.keys(definitions).flatMap(name => [
  `${name}(${argsFor(name)}${name === "patch" ? ", q: String, package_name: String, bundle_id: String" : ""}): [${name}!]!`,
  name === "patch_package" ? `${name}_by_pk(package_fk: Int!, patch_fk: Int!): ${name}` :
    `${name}_by_pk(id: Int!): ${name}`,
  name === "refresh_jobs" ? "" : `${name}_aggregate(${argsFor(name)}
    ${name === "patch" ? ", package_name: String, bundle_id: String" : ""}): ${name}_aggregate!`
]).join("\n");
const streams = Object.keys(definitions).map(name =>
  `${name}_stream(batch_size: Int!, cursor: [${name}_stream_cursor_input]!,
    where: ${name}_bool_exp): [${name}!]!`).join("\n");
const streamInputs = Object.entries(definitions).map(([name, fields]) => `
  input ${name}_stream_cursor_input {
    initial_value: ${name}_stream_cursor_value_input!, ordering: cursor_ordering
  }
  input ${name}_stream_cursor_value_input {
    ${Object.entries(fields).map(([key,type]) => key + ": " + type).join("\n")}
  }`).join("\n");
const historyArgs = "source_id: String, source: String, bundle_id: String, runtime: String, version: String, prerelease: Boolean, availability: String, from: String, to: String, order: String, limit: Int, after: String";
const historyRoots = `
  catalog_generation: String!
  historical_bundles(${argsFor("bundle")}, generation: String): [bundle!]!
  historical_patches(${argsFor("patch")}, generation: String): [patch!]!
  historical_packages(${argsFor("package")}, generation: String): [package!]!
  historical_patch_packages(${argsFor("patch_package")}, generation: String): [patch_package!]!
  historical_releases(${historyArgs}): historical_release_page!
  historical_release(id: String!): historical_release
  historical_apps(limit: Int, offset: Int, generation: String): [jsonb!]!
  historical_sources(limit: Int, offset: Int, generation: String): [historical_source!]!
`;
const historyTypes = `
  type historical_release {
    id: String!, source_id: String!, source_url: String!, upstream_id: String,
    name: String, tag: String, version: String, is_prerelease: Boolean!, draft: Boolean!,
    created_at: String, published_at: String, updated_at: String, first_seen_at: String,
    last_verified_at: String, changelog: String, release_notes: String,
    release_url: String, target_commitish: String, availability: String!,
    binary_archived: Boolean!, assets: jsonb, bundle_assets: jsonb, raw_metadata: jsonb,
    bundle_ids: [String!]!, runtimes: [String!]!, bundle_types: [String!]!,
    metadata_document_url: String, document(offset: Int, limit: Int): metadata_chunk!
  }
  type metadata_chunk { encoding: String!, data: String!, total_bytes: Int!, next_offset: Int }
  type historical_release_page {
    data: [historical_release!]!, next_cursor: String, generation: String!
  }
  type historical_source {
    source_id: String!, source_url: String!, checked_at: String, verified_at: String,
    status: String!, configured: Boolean!, required: Boolean, error: String, upstream_count: Int
  }
`;
export const schema = buildSchema(`
  scalar jsonb
  scalar bigint
  scalar timestamptz
  enum cursor_ordering { ASC DESC }
  ${streamInputs}
  enum order_by { asc desc asc_nulls_first asc_nulls_last desc_nulls_first desc_nulls_last }
  ${scalarComparisons}
  ${Object.entries(definitions).map(([name, fields]) => schemaFor(name, fields)).join("\n")}
  ${historyTypes}
  type query_root { ${roots} ${historyRoots} release(${argsFor("bundle")}): [bundle!]! }
  type subscription_root { ${roots} ${streams} release(${argsFor("bundle")}): [bundle!]! }
  schema { query: query_root, subscription: subscription_root }
`);
for (const name of ["jsonb", "timestamptz", "bigint"]) {
  const scalar = schema.getType(name);
  scalar.serialize = value => value;
  scalar.parseValue = value => value;
  scalar.parseLiteral = node => valueFromASTUntyped(node);
}

function containsKey(value, key) {
  return Boolean(value && typeof value === "object" &&
    (Object.hasOwn(value, key) || Object.values(value).some(v => containsKey(v, key))));
}
function equality(where, path) {
  let value = where;
  for (const key of path) value = value?.[key];
  return value?._eq ?? undefined;
}
function indexedPackage(where) {
  const names = new Set();
  function visit(value) {
    if (!value || typeof value !== "object") return;
    const name = equality(value, ["patch_packages", "package", "name"]);
    if (name) names.add(name);
    // Only conjunctions constrain the returned patch itself. A predicate on
    // another patch through its bundle must not narrow this patch's packages.
    (value._and ?? []).forEach(visit);
  }
  visit(where);
  return names.size === 1 ? [...names][0] : undefined;
}
function aggregate(rows, args = {}) {
  if (args.limit != null && args.limit !== 0)
    pagination({ limit: args.limit, offset: args.offset ?? 0 }, 100);
  const fullSet = !args.order_by && !args.distinct_on?.length && !args.offset &&
    (args.limit == null || args.limit >= rows.length);
  const data = args.limit === 0 ? [] : fullSet ?
    rows.filter(row => matches(row, args.where ?? {})) :
    selectRows(rows, { ...args, limit: args.limit ?? Math.max(1, rows.length) },
      Math.max(100, rows.length)).data;
  // Aggregate values share the node selection (including distinct, offset and limit).
  const values = {};
  values.count = ({ columns, distinct } = {}) => {
    const counted = columns?.length ? data.filter(row => columns.every(c => row[c] != null)) : data;
    return distinct && columns?.length ? new Set(counted.map(row =>
      JSON.stringify(columns.map(c => row[c])))).size : counted.length;
  };
  for (const op of ["min", "max", ...numericOperations]) {
    let cachedFields;
    // A count-only query must not calculate every numerical aggregate for
    // every column. GraphQL resolves only the operation and field requested.
    Object.defineProperty(values, op, { enumerable: true, get() {
      if (cachedFields) return cachedFields;
      const fields = { __aggregateKind: rows[0]?.__kind };
      for (const key of Object.keys(definitions[rows[0]?.__kind] ?? {})) {
        let cached, resolved = false;
        Object.defineProperty(fields, key, { enumerable: true, get() {
          if (resolved) return cached;
          const numbers = data.map(row => row[key]).filter(v => v != null);
          if (!numbers.length) { resolved = true; return cached = null; }
          if (op === "min" || op === "max") {
            cached = numbers.reduce((a,b) => {
              const timestamp = definitions[rows[0]?.__kind]?.[key] === "timestamptz";
              const compared = compareValues(a,b,timestamp);
              return op === "min" ? (compared < 0 ? a : b) : (compared > 0 ? a : b);
            });
            resolved = true;
            return cached;
          }
          if (!numbers.every(v => typeof v === "number")) {
            resolved = true;
            return cached = null;
          }
          const sum = numbers.reduce((a,b) => a+b, 0), mean = sum / numbers.length;
          const squares = numbers.reduce((a,b) => a + (b-mean)**2, 0);
          const sample = ["stddev", "stddev_samp", "variance", "var_samp"].includes(op);
          const variance = sample && numbers.length < 2 ? null : squares / (numbers.length - Number(sample));
          cached = op === "sum" ? sum : op === "avg" ? mean : variance == null ? null :
            op.startsWith("stddev") ? Math.sqrt(variance) : variance;
          resolved = true;
          return cached;
        } });
      }
      return cachedFields = fields;
    } });
  }
  return { aggregate: values, nodes: () => args.limit === 0 ? [] : selectRows(rows, args).data };
}
configureAggregateMatcher((rows, condition) => {
  const results = Object.entries(condition).map(([op, args]) => {
    if (args == null) return true;
    let selected = rows.filter(row => matches(row, args.filter ?? {}));
    if (op === "count") {
      const value = aggregate(selected).aggregate.count({
        columns: args.arguments, distinct: args.distinct
      });
      return filterResult({ value }, { value: args.predicate });
    }
    if (args.distinct) {
      const seen = new Set();
      selected = selected.filter(row => {
        const value = row[args.arguments];
        if (seen.has(value)) return false;
        seen.add(value); return true;
      });
    }
    let value;
    if (op === "bool_and" || op === "bool_or") {
      // PostgreSQL ignores NULL inputs and yields NULL for an empty/all-NULL set.
      const values = selected.map(row => row[args.arguments]).filter(v => v != null);
      value = values.length ? (op === "bool_and" ? values.every(Boolean) : values.some(Boolean)) : null;
    } else value = aggregate(selected).aggregate[op]?.[args.arguments] ?? null;
    return filterResult({ value }, { value: args.predicate });
  });
  return results.includes(false) ? false : results.includes(null) ? null : true;
});
function excludedByDirectives(node, variables) {
  for (const directive of node.directives ?? []) {
    const condition = directive.arguments?.find(arg => arg.name.value === "if");
    if (!condition) continue;
    const enabled = valueFromASTUntyped(condition.value, variables);
    if ((directive.name.value === "skip" && enabled === true) ||
        (directive.name.value === "include" && enabled === false)) return true;
  }
  return false;
}
function enforceComplexity(document, operation, variables, rootSizes = {}) {
  const fragments = new Map(document.definitions.filter(d => d.kind === "FragmentDefinition")
    .map(d => [d.name.value, d]));
  let fields = 0, cost = 0;
  function walk(set, depth, multiplier, parentType, stack = new Set(), aggregateLimit) {
    if (!set) return;
    const introspectionType = parentType?.name?.startsWith("__");
    if (depth > (introspectionType ? 24 : 8))
      throw new CatalogError("GraphQL depth exceeds 8");
    for (const node of set.selections) {
      if (excludedByDirectives(node, variables)) continue;
      if (node.kind === "Field" && ++fields > 300)
        throw new CatalogError("GraphQL field count exceeds 300");
      if (node.kind === "FragmentSpread") {
        if (stack.has(node.name.value)) throw new CatalogError("Cyclic GraphQL fragment");
        walk(fragments.get(node.name.value)?.selectionSet, depth, multiplier, parentType,
             new Set([...stack, node.name.value]), aggregateLimit);
      } else if (node.kind === "InlineFragment") {
        walk(node.selectionSet, depth, multiplier, parentType, stack, aggregateLimit);
      } else {
        const arg = node.arguments?.find(a => ["limit", "batch_size"].includes(a.name.value));
        const responseKey = node.alias?.value ?? node.name.value;
        const supplied = depth === 1 && Object.hasOwn(rootSizes, responseKey) ?
          rootSizes[responseKey] :
          (parentType?.name?.endsWith("_aggregate") && node.name.value === "nodes") ||
          (parentType?.name === "historical_release_page" && node.name.value === "data") ?
          aggregateLimit ?? 25 :
          arg ? valueFromASTUntyped(arg.value, variables) : 25;
        const fieldType = parentType?.getFields?.()[node.name.value]?.type ??
          (node.name.value === "__schema" ? schema.getType("__Schema") :
           node.name.value === "__type" ? schema.getType("__Type") : undefined);
        const nullable = isNonNullType(fieldType) ? fieldType.ofType : fieldType;
        const factor = introspectionType || node.name.value.startsWith("__") ? 1 :
          isListType(nullable) ? Math.max(1, Number(supplied ?? 25)) : 1;
        if (!Number.isInteger(factor) || factor < 0 || factor > 100)
          throw new CatalogError("GraphQL list limit must be 1–100");
        cost += multiplier;
        if (cost > 20000) throw new CatalogError("GraphQL query complexity exceeds 20000");
        const nextType = fieldType ? getNamedType(fieldType) : undefined;
        const nextLimit = nextType?.name?.endsWith("_aggregate") || nextType?.name === "historical_release_page" ?
          (arg ? valueFromASTUntyped(arg.value, variables) : 25) : undefined;
        walk(node.selectionSet, depth + 1, multiplier * factor,
             nextType, stack, nextLimit);
      }
    }
  }
  walk(operation.selectionSet, 1, 1,
    operation.operation === "subscription" ? schema.getSubscriptionType() : schema.getQueryType());
}

function needsBundleDescriptions(document, operation, variables) {
  const fragments = new Map(document.definitions.filter(def => def.kind === "FragmentDefinition")
    .map(def => [def.name.value, def]));
  function inputUsesDescription(type, value) {
    type = type && getNamedType(type);
    if (!type || value == null) return false;
    if (Array.isArray(value)) return value.some(item => inputUsesDescription(type, item));
    // DISTINCT and aggregate count refer to scalar columns through an enum,
    // and streaming cursors use a separate input type.
    if (type.name === "bundle_select_column") return value === "description";
    if (typeof value !== "object" || !type.getFields) return false;
    const fields = type.getFields();
    return Object.entries(value).some(([key, item]) =>
      ((type.name === "bundle_bool_exp" || type.name === "bundle_order_by") &&
        key === "description") ||
      (["bundle_min_order_by", "bundle_max_order_by"].includes(type.name) &&
        key === "description") ||
      (type.name === "bundle_stream_cursor_value_input" &&
        key === "description" && item != null) ||
      (fields[key] && inputUsesDescription(fields[key].type, item)));
  }
  function visit(set, parent, stack = new Set()) {
    for (const node of set?.selections ?? []) {
      if (excludedByDirectives(node, variables)) continue;
      if (node.kind === "FragmentSpread") {
        const fragment = fragments.get(node.name.value);
        if (fragment && !stack.has(node.name.value) &&
            visit(fragment.selectionSet, schema.getType(fragment.typeCondition.name.value),
              new Set([...stack, node.name.value]))) return true;
        continue;
      }
      if (node.kind === "InlineFragment") {
        if (visit(node.selectionSet, node.typeCondition ?
          schema.getType(node.typeCondition.name.value) : parent, stack)) return true;
        continue;
      }
      if (node.name.value === "description" &&
          ["bundle_min_fields", "bundle_max_fields"].includes(parent?.name))
        return true;
      const field = parent?.getFields?.()[node.name.value];
      if (!field) continue;
      for (const arg of node.arguments ?? []) {
        const argType = field.args.find(input => input.name === arg.name.value)?.type;
        if (inputUsesDescription(argType, valueFromASTUntyped(arg.value, variables))) return true;
      }
      if (node.selectionSet && visit(node.selectionSet, getNamedType(field.type), stack)) return true;
    }
    return false;
  }
  return visit(operation.selectionSet, operation.operation === "subscription" ?
    schema.getSubscriptionType() : schema.getQueryType());
}

export function withPostgresLocale(locale, callback) {
  const matcher = createPostgresMatcher(locale);
  matcher.compare = createPostgresComparator(locale);
  return regexContext.run(matcher, callback);
}
export function runGraphQL(catalog, payload, options = {}) {
  return withPostgresLocale(catalog.regexLocale ?? site.postgres_locale ?? "en_US.utf8",
    () => executeQuery(catalog, payload, options));
}
export function subscriptionPayload(payload) {
  if (!payload || typeof payload.query !== "string" || payload.query.length > 20000)
    throw new CatalogError("Expected a GraphQL operation of at most 20000 characters");
  const document = parse(payload.query, { maxTokens: 4000 });
  const operation = getOperationAST(document, payload.operationName);
  if (!operation || !["query", "subscription"].includes(operation.operation))
    throw new CatalogError("Only read-only queries and subscriptions are supported");
  const errors = validate(schema, document);
  if (errors.length) throw new CatalogError(errors.map(error => error.message).join("; "));
  const stream = operation.operation === "subscription";
  return { payload, stream };
}
async function executeQuery(catalog, payload, options) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      (payload.variables != null && (typeof payload.variables !== "object" || Array.isArray(payload.variables))) ||
      (payload.operationName != null && typeof payload.operationName !== "string"))
    throw new CatalogError("Expected one GraphQL query object with optional variables and operationName");
  if (typeof payload.query !== "string" || payload.query.length > 20000)
    throw new CatalogError("GraphQL query must contain at most 20000 characters");
  let validated = validatedQueries.get(payload.query);
  let document = validated?.document;
  if (!document) {
    try { document = parse(payload.query, { maxTokens: 4000 }); }
    catch (error) { throw new CatalogError(error.message); }
  }
  const operation = getOperationAST(document, payload.operationName);
  if (!operation || (operation.operation !== "query" &&
      !(operation.operation === "subscription" && options.subscription)))
    throw new CatalogError("Only named or unambiguous read-only queries are supported");
  if (!validated) {
    const errors = validate(schema, document);
    if (errors.length) return { errors: errors.map(e => ({ message: e.message })) };
    let live = false;
    visit(document, { Field(node) {
      if (node.name.value === "refresh_jobs") live = true;
    } });
    validated = { document, live };
    if (payload.query.length <= 4096) {
      if (validatedQueries.size >= MAX_VALIDATED_QUERIES)
        validatedQueries.delete(validatedQueries.keys().next().value);
      validatedQueries.set(payload.query, validated);
    }
  } else {
    validatedQueries.delete(payload.query);
    validatedQueries.set(payload.query, validated);
  }
  if (operation.operation === "query" && !validated.live) options.onCacheableQuery?.();
  const variables = getVariableValues(schema, operation.variableDefinitions ?? [], payload.variables ?? {});
  if (variables.errors) return { errors: variables.errors.map(e => ({ message: e.message })) };
  enforceComplexity(document, operation, variables.coerced);
  if (catalog.graph) {
    const planned = await catalog.graph(schema, document, operation, variables.coerced, payload);
    if (planned) return planned;
  }
  let needsPackageLinks = false;
  const fragments = new Map(document.definitions.filter(d=>d.kind==="FragmentDefinition")
    .map(d=>[d.name.value,d]));
  const seenPackageFragments = new Set();
  function scanPackageLinks(root) {
    visit(root,{
      Field(node) {
        if (excludedByDirectives(node, variables.coerced)) return false;
        if (node.name.value.startsWith("patch_package")) needsPackageLinks = true;
        // Only variables referenced by an executed field can require package
        // relations. A skipped field's unused variables must not force I/O.
        if (node.arguments?.some(arg =>
          containsKey(valueFromASTUntyped(arg.value, variables.coerced), "patch_packages") ||
          containsKey(valueFromASTUntyped(arg.value, variables.coerced), "patch_packages_aggregate")))
          needsPackageLinks = true;
      },
      ObjectField(node) {
        if (node.name.value.startsWith("patch_packages")) needsPackageLinks = true;
      },
      InlineFragment(node) {
        if (excludedByDirectives(node, variables.coerced)) return false;
      },
      FragmentSpread(node) {
        if (excludedByDirectives(node, variables.coerced)) return false;
        const name = node.name.value;
        if (!seenPackageFragments.has(name) && fragments.has(name)) {
          seenPackageFragments.add(name);
          scanPackageLinks(fragments.get(name).selectionSet);
        }
      }
    });
  }
  scanPackageLinks(operation.selectionSet);
  const sourceMap = new Map(), bundleMap = new Map();
  const tables = { source: [], bundle: [], source_metadata: [] };
  let bundleRows = [];
  let graphPromise, descriptionsPromise;
  async function ensureGraph() {
    graphPromise ??= (async () => {
      const sourceRows = await catalog.sources();
      if (catalog.manifest.files["graphql-bundles.json"]) {
        const compact = await catalog.file("graphql-bundles.json");
        bundleRows = compact.rows.map(values =>
          Object.fromEntries(compact.columns.map((name, index) => [name, values[index]])));
        const enabled = new Map(sourceRows.filter(row => row.enabled !== false).map(row => [row.id, row]));
        bundleRows = bundleRows.filter(row => enabled.has(row.source_id)).map(row => ({
          ...row, ...bundleImages({ ...row, source: enabled.get(row.source_id) })
        }));
      } else bundleRows = await catalog.bundles();
      sourceRows.forEach((row, i) => {
    const source = { ...graphRow("source", row), id: row.legacy_id ?? i + 1,
      catalog_id: row.id, unavailable_reason: row.unavailable_reason ?? null, bundles: [] };
    const metadata = { ...graphRow("source_metadata", row.source_metadatum),
      id: row.source_metadatum.id ?? i + 1, source_fk: source.id, source };
    source.source_metadatum = metadata;
    lazyAggregateOrder(source, "bundles");
    sourceMap.set(row.id, source);
    tables.source.push(source); tables.source_metadata.push(metadata);
  });
  bundleRows.forEach((row, i) => {
    const source = sourceMap.get(row.source_id);
    const bundle = { ...graphRow("bundle", row), id: row.legacy_id ?? i + 1,
      catalog_id: row.id, source_fk: source.id, source, patches: [],
      patcher_failure_fingerprint: row.patcher_failure_fingerprint ?? null };
    lazyAggregateOrder(bundle, "patches");
    bundleMap.set(row.id, bundle); source.bundles.push(bundle); tables.bundle.push(bundle);
  });
    })();
    return graphPromise;
  }
  async function ensureDescriptions() {
    await ensureGraph();
    if (!catalog.manifest.files["graphql-bundle-descriptions.json"]) return;
    descriptionsPromise ??= (async () => {
      const descriptions = await catalog.file("graphql-bundle-descriptions.json");
      for (const bundle of tables.bundle)
        bundle.description = descriptions[bundle.catalog_id] ?? null;
    })();
    await descriptionsPromise;
  }
  if (needsBundleDescriptions(document, operation, variables.coerced))
    await ensureDescriptions();
  let packagePromise;
  async function packages() {
    packagePromise ??= (async () => {
      const rows = catalog.manifest.files["package-records.json"] ?
        await catalog.file("package-records.json") :
        (await catalog.file("packages.json")).flatMap(p =>
          (p.versions.length ? p.versions : [null]).map(version => ({ ...p, version })));
      tables.package = rows.map((row, i) => ({ ...graphRow("package", row),
        id: row.id ?? i + 1, patch_packages: [] }));
      for (const pkg of tables.package) lazyAggregateOrder(pkg, "patch_packages");
      return new Map(tables.package.map(row => [JSON.stringify([row.name, row.version]), row]));
    })();
    return packagePromise;
  }
  const patchesByHash = new Map();
  async function joinPatches(rows) {
    if (!rows.length) return [];
    // Scalar patch fields and bundle relationships do not need the entire
    // package table. Load and link it only for package relationship queries.
    const packageMap = needsPackageLinks ? await packages() : null;
    for (const row of rows) {
      if (patchesByHash.has(row.id)) continue;
      const bundle = bundleMap.get(row.bundle_id);
      const patch = { ...graphRow("patch", row), id: row.legacy_id ?? patchesByHash.size + 1,
        catalog_id: row.id, bundle_fk: bundle.id, bundle, patch_packages: [] };
      lazyAggregateOrder(patch, "patch_packages");
      if (packageMap)
        for (const pkg of row.packages) for (const version of pkg.versions.length ? pkg.versions : [null]) {
          const packageRow = packageMap.get(JSON.stringify([pkg.name, version]));
          if (!packageRow) throw new CatalogError("Package relationship index unavailable", 503);
          const link = { __kind: "patch_package", package_fk: packageRow.id, patch_fk: patch.id,
            patch_id: row.id, package: packageRow, patch };
          patch.patch_packages.push(link); packageRow.patch_packages.push(link);
        }
      patchesByHash.set(row.id, patch); bundle.patches.push(patch);
    }
    return rows.map(row => patchesByHash.get(row.id));
  }
  function aggregateOrder(rows) {
    let computed;
    const value = { count: rows.length };
    for (const op of ["min", "max", ...numericOperations])
      Object.defineProperty(value, op, { get() {
        // Ordering by a relationship's count needs only its length.
        computed ??= aggregate(rows).aggregate;
        return computed[op];
      } });
    return value;
  }
  function lazyAggregateOrder(row, relation) {
    let count = -1, cached;
    Object.defineProperty(row, relation + "_aggregate", { get() {
      // Relationship hydration can append rows after the first lookup.
      if (row[relation].length !== count) {
        count = row[relation].length;
        cached = aggregateOrder(row[relation]);
      }
      return cached;
    } });
  }
  function positive(where, path) {
    // Direct predicates and conjunctions remain mandatory alongside OR/NOT predicates.
    // Never descend into an OR/NOT branch when deriving an index constraint.
    if (!where || typeof where !== "object") return;
    const direct = path.length ?
      positive(where[path[0]], path.slice(1)) : where._eq;
    if (direct != null) return direct;
    for (const nested of where?._and ?? []) {
      const value = positive(nested, path);
      if (value != null) return value;
    }
  }
  function mandatoryIn(where, path) {
    // Each equality/IN predicate outside OR/NOT is a necessary constraint.
    // Intersect all conjuncts instead of taking the first (possibly broad)
    // list, including inside relationship-level conjunctions.
    if (!where || typeof where !== "object") return;
    const necessary = [];
    if (path.length) {
      const direct = mandatoryIn(where[path[0]], path.slice(1));
      if (direct) necessary.push(direct);
    } else {
      if (Array.isArray(where._in)) necessary.push(where._in);
      if (where._eq != null) necessary.push([where._eq]);
    }
    for (const nested of where._and ?? []) {
      const values = mandatoryIn(nested, path);
      if (values) necessary.push(values);
    }
    if (necessary.length)
      return necessary.reduce((intersection, values) =>
        intersection.filter(value => values.includes(value)));
  }
  function mandatoryBundleDescriptions(where) {
    // Only predicates outside OR/NOT are safe constraints for patch shards.
    function withinBundle(bundle) {
      return [...(bundle?.description ? [bundle.description] : []),
        ...(bundle?._and ?? []).flatMap(withinBundle)];
    }
    return [...withinBundle(where?.bundle),
      ...(where?._and ?? []).flatMap(mandatoryBundleDescriptions)];
  }
  async function loadPatches(args, scopedBundle, scopedPackage, parentKind) {
    await ensureGraph();
    const where = args.where ?? {};
    const exactName = positive(where, ["name"]);
    const numericBundle = (parentKind === "bundle" ? positive(where, ["id"]) : undefined) ??
      positive(where, ["bundle_fk"]) ?? positive(where, ["bundle", "id"]);
    const canonicalBundle = args.bundle_id ?? positive(where, ["bundle_id"]) ??
      positive(where, ["bundle", "catalog_id"]);
    const sourceUrl = (parentKind === "source" ? positive(where, ["url"]) : undefined) ??
      positive(where, ["bundle", "source", "url"]) ?? positive(where, ["source", "url"]);
    const metadataId = parentKind === "source_metadata" ? positive(where, ["id"]) : undefined;
    const sourceId = (parentKind === "source" ? positive(where, ["id"]) : undefined) ??
      (metadataId != null ? tables.source_metadata.find(row => row.id === metadataId)?.source_fk : undefined) ??
      positive(where, ["bundle", "source_fk"]) ?? positive(where, ["source_fk"]);
    let ids = scopedBundle ? [scopedBundle.catalog_id] :
      canonicalBundle ? [canonicalBundle] :
      numericBundle != null || sourceUrl || sourceId != null ?
      tables.bundle.filter(b => (numericBundle == null || b.id === numericBundle) &&
        (!sourceUrl || b.source.url === sourceUrl) && (sourceId == null || b.source_fk === sourceId))
        .map(b => b.catalog_id) : undefined;
    const foreignKeyIds = mandatoryIn(where, ["bundle_fk"]);
    const relationshipIds = mandatoryIn(where, ["bundle", "id"]);
    // These are predicates on the same numeric bundle ID. Both must hold,
    // even when each path appears in a separate conjunctive branch.
    const numericBundleList = foreignKeyIds && relationshipIds ?
      foreignKeyIds.filter(id => relationshipIds.includes(id)) :
      foreignKeyIds ?? relationshipIds;
    if (numericBundleList) {
      const eligible = new Set(tables.bundle.filter(bundle =>
        numericBundleList.includes(bundle.id)).map(bundle => bundle.catalog_id));
      ids = ids ? ids.filter(id => eligible.has(id)) : [...eligible];
    }
    const descriptions = mandatoryBundleDescriptions(where);
    if (descriptions.length) {
      const eligible = new Set(tables.bundle.filter(bundle =>
        descriptions.every(condition => matches(bundle, { description: condition })))
        .map(bundle => bundle.catalog_id));
      ids = ids ? ids.filter(id => eligible.has(id)) : [...eligible];
    }
    const rows = (await catalog.patchRows({ all: true,
      bundle_ids: ids, package: scopedPackage ?? args.package_name ?? indexedPackage(where),
      patch_id: parentKind ? undefined : positive(where, ["id"]), patch_ids: args.patch_ids,
      // An exact name is a mandatory substring of the indexed patch text.
      // Let the trigram index narrow shards before applying the full predicate.
      q: args.q ?? (typeof exactName === "string" && [...exactName].length >= 3 ? exactName : ""),
      include_unverified: true, bundle_rows: bundleRows })).rows;
    await joinPatches(rows);
    if (containsKey(where, "patches") || containsKey(where, "patches_aggregate") ||
        containsKey(args.order_by, "patches_aggregate")) {
      // A predicate on another patch needs complete sibling rows. Scope that
      // hydration to the selected bundles, or their sources when source.bundles
      // is traversed, without narrowing the patch rows returned by this query.
      let relatedIds = ids ?? [...new Set(rows.map(row => row.bundle_id))];
      if (containsKey(where, "bundles") || containsKey(args.order_by, "bundles_aggregate")) {
        const owners = new Set(relatedIds.map(id => bundleMap.get(id)?.source_fk));
        relatedIds = tables.bundle.filter(bundle => owners.has(bundle.source_fk))
          .map(bundle => bundle.catalog_id);
      }
      await joinPatches((await catalog.patchRows({all:true, bundle_ids:relatedIds,
        include_unverified:true, bundle_rows:bundleRows})).rows);
    }
    return rows.map(row => patchesByHash.get(row.id));
  }
  const relationLoads = new Map();
  function narrowed(rows, condition) {
    // Mandatory equalities keep source/package filters within their shard scope.
    // Nullable comparisons cannot prune rows: SQL UNKNOWN may still combine
    // with a false relationship predicate under NOT.
    for (const key of Object.keys(definitions[rows[0]?.__kind] ?? {})) {
      const expected = positive(condition, [key]);
      if (expected != null && rows.every(row => row[key] != null))
        rows = rows.filter(row => matches(row, {[key]:{_eq:expected}}));
    }
    return rows;
  }
  async function hydrateRelations(rows, condition) {
    if (!rows.length || !condition || typeof condition !== "object") return;
    if (Array.isArray(condition)) {
      for (const part of condition) await hydrateRelations(rows, part);
      return;
    }
    rows = narrowed(rows, condition);
    if (!rows.length) return;
    const kind = rows[0].__kind;
    for (const [key, value] of Object.entries(condition)) {
      if (key === "_and" || key === "_or") {
        for (const part of value ?? []) await hydrateRelations(rows, part);
        continue;
      }
      if (key === "_not") { await hydrateRelations(rows, value); continue; }
      const isAggregate = key.endsWith("_aggregate");
      const relation = isAggregate ? key.slice(0, -10) : key;
      if (!arrays[kind]?.[relation] && !objects[kind]?.[relation]) continue;
      // Reverse relationships must include peers outside the outer query's
      // patch/bundle scope. Load only the referenced bundle or package shards.
      if (kind === "bundle" && relation === "patches") {
        const ids = [...new Set(rows.map(row => row.catalog_id))];
        const missing = ids.filter(id => !relationLoads.has("bundle:" + id));
        if (missing.length) {
          const pending = catalog.patchRows({all:true,bundle_ids:missing,
            include_unverified:true,bundle_rows:bundleRows})
            .then(result => joinPatches(result.rows));
          for (const id of missing) relationLoads.set("bundle:" + id, pending);
        }
        await Promise.all(ids.map(id => relationLoads.get("bundle:" + id)));
      } else if (kind === "package" && relation === "patch_packages") {
        const names = [...new Set(rows.map(row => row.name))];
        for (const name of names) if (!relationLoads.has("package:" + name))
          relationLoads.set("package:" + name,
            catalog.patchRows({all:true,package:name,include_unverified:true,
              bundle_rows:bundleRows})
              .then(result => joinPatches(result.rows)));
        await Promise.all(names.map(name => relationLoads.get("package:" + name)));
      }
      const related = [...new Set(rows.flatMap(row => row[relation] ?? []))];
      if (isAggregate) {
        for (const args of Object.values(value ?? {}))
          await hydrateRelations(related, args?.filter);
      } else await hydrateRelations(related, value);
    }
  }
  async function prepared(rows, args) {
    rows = narrowed(rows, args.where);
    await hydrateRelations(rows, args.where);
    await hydrateRelations(rows, args.order_by);
    return rows;
  }
  async function selected(rows, args) {
    return args.limit === 0 ? [] : selectRows(await prepared(rows, args), args).data;
  }
  async function rowsFor(kind, args) {
    const where = args.where ?? {};
    if (kind === "patch") return loadPatches(args);
    if (kind === "patch_package") {
      await ensureGraph();
      const packageId = positive(where, ["package_fk"]) ?? positive(where, ["package", "id"]);
      if (packageId != null) await packages();
      const packageRow = packageId != null ? tables.package.find(row => row.id === packageId) : undefined;
      if (packageId != null && !packageRow) return [];
      const pkg = positive(where, ["package", "name"]) ?? packageRow?.name;
      const patchId = positive(where, ["patch_fk"]);
      const patches = await loadPatches({ ...args,
        where: patchId != null ? {_and:[where, {id:{_eq:patchId}}]} : where }, undefined, pkg);
      return patches.flatMap(patch => patch.patch_packages);
    }
    if (kind === "package") {
      await packages();
      const id = positive(where, ["id"]);
      if (id != null && !tables.package.some(row => row.id === id)) return [];
      if (containsKey(where, "patch_packages") || containsKey(where, "patch_packages_aggregate") ||
          containsKey(args.order_by, "patch_packages_aggregate")) {
        const name = positive(where, ["name"]) ??
          tables.package.find(p => p.id === positive(where, ["id"]))?.name;
        await loadPatches(args, undefined, name, "package");
      }
      return tables.package;
    }
    if (kind === "refresh_jobs") {
      if (!tables.refresh_jobs) {
        const recorded = catalog.manifest.files["refresh-jobs.json"] ?
          await catalog.file("refresh-jobs.json") : [];
        let live = [];
        try { live = catalog.liveJobs ? await catalog.liveJobs() : []; }
        catch (error) { if (!recorded.length) throw error; }
        tables.refresh_jobs = mergeJobs(recorded, live).map(row => graphRow(kind, row));
      }
      return tables.refresh_jobs;
    }
    await ensureGraph();
    if (kind === "source_metadata") {
      const id = positive(where, ["id"]);
      if (id != null && !tables.source_metadata.some(row => row.id === id)) return [];
    }
    if (containsKey(where, "patches") || containsKey(where, "patches_aggregate") ||
        containsKey(args.order_by, "patches_aggregate")) {
      await loadPatches(args, undefined, undefined, kind);
    }
    return tables[kind];
  }
  const rootValues = {};
  const streamState = { cursor: { ...(options.cursor ?? {}) }, empty: true };
  let cursorStream = false;
  for (const kind of Object.keys(definitions)) {
    rootValues[kind] = async args => selected(await rowsFor(kind, args), args);
    rootValues[kind + "_aggregate"] = async args =>
      aggregate(await prepared(await rowsFor(kind, args), args), args);
    rootValues[kind + "_by_pk"] = async args => {
      const where = kind === "patch_package" ?
        { package_fk: { _eq: args.package_fk }, patch_fk: { _eq: args.patch_fk } } :
        { id: { _eq: args.id } };
      return (await rowsFor(kind, { where })).find(row => matches(row, where)) ?? null;
    };
  }
  const defaultPatchRoot = rootValues.patch;
  rootValues.patch = async args => {
    const order = args.order_by ?? [{id:"asc"}];
    const simpleOrder = order.length === 1 && Object.keys(order[0]).length === 1 &&
      ["asc","desc"].includes(order[0].id);
    const idOnly = !args.where || !Object.keys(args.where).length ||
      (Object.keys(args.where).length === 1 && Object.hasOwn(args.where,"id"));
    const nameList = mandatoryIn(args.where ?? {}, ["name"]);
    if (!args.q && !args.package_name && !args.bundle_id && !args.patch_ids &&
        !args.distinct_on?.length && simpleOrder && Array.isArray(nameList) &&
        nameList.every(name => typeof name === "string") &&
        catalog.manifest.files["patch-name-ids.json"]) {
      if (args.limit === 0) return [];
      const {limit,offset} = pagination(args);
      const index = await catalog.file("patch-name-ids.json");
      const ids = [...new Set(nameList.flatMap(name =>
        Object.hasOwn(index,name) ? index[name] : []))].sort((a,b)=>a-b);
      const ordered = order[0].id === "desc" ? ids.slice().reverse() : ids;
      const exactOnly = Object.keys(args.where).length === 1 &&
        Object.keys(args.where.name ?? {}).length === 1 &&
        (Object.hasOwn(args.where.name, "_eq") || Object.hasOwn(args.where.name, "_in"));
      if (exactOnly) {
        const rows = [];
        const window = ordered.slice(offset,offset+limit);
        for (let i = 0; i < window.length; i += 12)
          rows.push(...await loadPatches({patch_ids:window.slice(i,i+12)}));
        return selected(rows,{...args,offset:0});
      }
      const matched = [];
      for (let i = 0; i < ordered.length && matched.length < offset + limit; i += 12) {
        const batch = await loadPatches({patch_ids:ordered.slice(i,i+12)});
        await prepared(batch,args);
        batch.sort((a,b)=>order[0].id==="desc" ? b.id-a.id : a.id-b.id);
        matched.push(...batch.filter(row=>matches(row,args.where)));
      }
      return selected(matched,args);
    }
    if ((args.q || args.package_name) && (!args.where || !Object.keys(args.where).length) &&
        !args.bundle_id && !args.distinct_on?.length &&
        simpleOrder) {
      if (args.limit === 0) return [];
      await ensureGraph();
      const {limit,offset} = pagination(args);
      const found = [];
      let cursor = 0;
      let skipped = 0;
      if (args.package_name && !args.q &&
          catalog.manifest.files["patch-package-counts.json"]) {
        const counts = (await catalog.file("patch-package-counts.json"))[args.package_name] ?? {};
        const pages = Object.keys(counts).sort();
        if (order[0].id === "desc") pages.reverse();
        for (const page of pages) {
          if (skipped + counts[page] > offset) break;
          skipped += counts[page];
          cursor++;
        }
      }
      // Patch shards are sorted by legacy ID. Walk forward or backward to
      // fetch only the requested window, keeping the same budgets.
      while (found.length < limit + offset - skipped) {
        const page = await catalog.patchRows({ q:args.q ?? "",
          package:args.package_name, page_cursor:cursor,
          page_count:1, include_unverified:true, bundle_rows:bundleRows,
          reverse_pages:order[0].id === "desc" });
        found.push(...page.rows);
        if (page.next_cursor == null) break;
        cursor = page.next_cursor;
      }
      const rows = await joinPatches(found);
      return selected(rows,{...args,offset:offset-skipped});
    }
    if (idOnly && !args.q && !args.package_name &&
        !args.bundle_id && !args.distinct_on?.length && simpleOrder) {
      const index = await catalog.file("patch-index.json");
      if (index.patch_ids) {
        if (args.limit === 0) return [];
        const {limit,offset} = pagination(args);
        const ids = Object.keys(index.patch_ids).map(Number)
          .filter(id => matches({id},args.where ?? {})).sort((a,b)=>a-b);
        if (order[0].id === "desc") ids.reverse();
        const rows = await loadPatches({patch_ids:ids.slice(offset,offset+limit)});
        return selected(rows,{...args,offset:0});
      }
    }
    return defaultPatchRoot(args);
  };
  const defaultPatchAggregate = rootValues.patch_aggregate;
  rootValues.patch_aggregate = async args => {
    const exactName = args.where?.name?._eq;
    if (typeof exactName === "string" && Object.keys(args).length === 1 &&
        Object.keys(args.where).length === 1 &&
        Object.keys(args.where.name).length === 1 &&
        catalog.manifest.files["patch-name-ids.json"]) {
      const index = await catalog.file("patch-name-ids.json");
      const ids = Object.hasOwn(index,exactName) ? index[exactName] : [];
      let fallback;
      const full = async () => {
        fallback ??= defaultPatchAggregate(args);
        return (await fallback).aggregate;
      };
      let indexedAggregate;
      const indexedId = op => {
        indexedAggregate ??= aggregate(ids.map(id => ({__kind:"patch",id}))).aggregate;
        return indexedAggregate[op].id;
      };
      const operations = Object.fromEntries(["min","max",...numericOperations].map(op =>
        [op, ids.length ? async () => (await full())[op] : () => ({})]));
      for (const op of ["min","max"]) operations[op] = () => ({
        name: ids.length ? exactName : null,
        id: ids.length ? () => indexedId(op) : null,
        ...Object.fromEntries(Object.entries(definitions.patch)
          .filter(([key,type]) => key !== "name" && key !== "id" && type !== "Boolean")
          .map(([key]) => [key, ids.length ?
            async () => (await full())[op]?.[key] ?? null : null]))
      });
      for (const op of numericOperations) operations[op] = () => ({
        id: ids.length ? () => indexedId(op) : null,
        bundle_fk: ids.length ? async () => (await full())[op]?.bundle_fk ?? null : null
      });
      return {aggregate:{
        ...operations,
        count: async ({columns,distinct}={}) => {
          if (!ids.length) return 0;
          if (!columns?.length || columns.every(column =>
            column === "id" || column === "name"))
            return distinct && columns?.length && !columns.includes("id") ? 1 : ids.length;
          return (await full()).count({columns,distinct});
        }
      },nodes:()=>rootValues.patch(args)};
    }
    if (!Object.keys(args).length && catalog.manifest.files["patch-statistics.json"]) {
      const stats = await catalog.file("patch-statistics.json");
      const locale = String(catalog.regexLocale ?? site.postgres_locale ?? "en_US.utf8")
        .toLowerCase().replace(/[-_.]/g,"");
      const profile = ["c","posix","cutf8"].includes(locale) ? "C" : "en_US.utf8";
      const extrema = stats.text_extrema?.[profile];
      const aggregates = {...stats.aggregate};
      for (const op of ["min","max"]) aggregates[op] = extrema ?
        {...aggregates[op],...extrema[op]} :
        async () => (await defaultPatchAggregate({})).aggregate[op];
      return { aggregate: {...aggregates,count:async ({columns,distinct}={})=>{
        if (!columns?.length) return stats.count;
        if (columns.some(column=>!(stats.columns ?? []).includes(column)))
          return (await defaultPatchAggregate({})).aggregate.count({columns,distinct});
        if (columns.length > 1) {
          if (distinct) throw new CatalogError("Narrow the patch filter for multi-column distinct counts",422);
          const required = columns.reduce((mask,key)=>mask | (1 << stats.columns.indexOf(key)),0);
          return Object.entries(stats.null_masks).reduce((total,[mask,count]) =>
            total + ((Number(mask) & required) === 0 ? count : 0),0);
        }
        return (distinct ? stats.distinct : stats.nonnull)[columns[0]] ?? 0;
      }}, nodes:()=>rootValues.patch({}) };
    }
    return defaultPatchAggregate(args);
  };
  rootValues.release = rootValues.bundle;
  rootValues.catalog_generation = () => catalog.manifest.generation;
  rootValues.historical_releases = args => {
    if (!catalog.history) throw new CatalogError("Historical archive requires the D1 backend",503);
    return catalog.history(args);
  };
  rootValues.historical_release = async args =>
    (await rootValues.historical_releases({id:args.id,limit:1})).data[0] ?? null;
  for (const [root,kind] of Object.entries({historical_bundles:"bundle",historical_patches:"patch",
    historical_packages:"package",historical_patch_packages:"patch_package"}))
    rootValues[root] = args => {
      if (!catalog.rows) throw new CatalogError("Historical archive requires the D1 backend",503);
      return catalog.rows(kind,{...args,include_archived:true});
    };
  rootValues.historical_apps = async args => {
    if (!catalog.rows) throw new CatalogError("Historical archive requires the D1 backend",503);
    return (await catalog.rows("app",{...args,include_archived:true})).map(({__kind,__archived,...row})=>row);
  };
  rootValues.historical_sources = args => {
    if (!catalog.rows) throw new CatalogError("Historical archive requires the D1 backend",503);
    return catalog.rows("history_source",args);
  };
  for (const kind of Object.keys(definitions)) {
    rootValues[kind + "_stream"] = async (args, info) => {
      cursorStream = true;
      const key = info.path.key;
      const selection = streamArguments(args, streamState.cursor[key]);
      let batch;
      // Unique numeric patch IDs can use the compact index, avoiding a broad
      // scan while keeping the same shard and response budgets.
      if (kind === "patch" && selection.columns.length === 1 &&
          selection.columns[0].name === "id") {
        const id = selection.where._and[1]._or[0];
        const where = !args.where || !Object.keys(args.where).length ? id : selection.where;
        const data = await rootValues.patch({...selection,where});
        batch = {data,cursor:data.length ? [data.at(-1).id] : null};
      } else {
        const rows = await prepared(await rowsFor(kind,selection),selection);
        batch = streamBatch(rows,selection);
      }
      // WITH TIES may return more rows than batch_size. Charge the full batch
      // before GraphQL expands its nested relationships.
      enforceComplexity(document, operation, variables.coerced, {[key]:batch.data.length});
      if (batch.cursor) { streamState.cursor[key] = batch.cursor; streamState.empty = false; }
      return batch.data;
    };
  }
  const result = await execute({
    schema, document, rootValue: rootValues, variableValues: variables.coerced,
    operationName: payload.operationName,
    fieldResolver: async (source, args, context, info) => {
      if (["query_root","subscription_root"].includes(info.parentType.name))
        return rootValues[info.fieldName]?.(args,info);
      const field = info.fieldName;
      if (info.parentType.name === "historical_release" && field === "document")
        return catalog.historyDocument(source.id,args);
      if (source?.__archived && catalog.historicalField) {
        const resolved = await catalog.historicalField(source,args,info);
        if (resolved.handled) return resolved.value;
        return source[field];
      }
      if (source?.__kind === "bundle" && field === "description") {
        if (descriptionsPromise) return source.description;
        const shard = "graphql-descriptions/" + Math.floor(source.id / 400) + ".json";
        if (catalog.manifest.files[shard])
          return (await catalog.file(shard))[source.catalog_id] ?? null;
        if (catalog.manifest.files["graphql-bundle-descriptions.json"])
          return (await catalog.file("graphql-bundle-descriptions.json"))[source.catalog_id] ?? null;
        return (await catalog.file("bundles/" + source.catalog_id + ".json")).description;
      }
      const isAggregate = field.endsWith("_aggregate");
      const relation = isAggregate ? field.slice(0, -10) : field;
      if (arrays[source?.__kind]?.[relation]) {
        let rows;
        if (source.__kind === "bundle") rows = await loadPatches(args, source);
        else if (source.__kind === "package") {
          await ensureGraph();
          await loadPatches(args, undefined, source.name);
          rows = source.patch_packages;
        } else if (source.__kind === "source") {
          if (containsKey(args.where, "patches") || containsKey(args.where, "patches_aggregate") ||
              containsKey(args.order_by, "patches_aggregate"))
            await loadPatches({where:{_and:[args.where ?? {}, {source_fk:{_eq:source.id}}]}},
                              undefined, undefined, "bundle");
          rows = source.bundles;
        } else rows = source[relation];
        return isAggregate ? aggregate(await prepared(rows, args), args) : selected(rows, args);
      }
      const value = source?.[field];
      return typeof value === "function" ? value(args) : value;
    }
  });
  return cursorStream ? {...result, extensions:{registryStream:streamState}} : result;
}
