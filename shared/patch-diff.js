import { patchDisplayName } from "./site.js";
import { formatPatchDescription, renderablePatchOptions } from "./details.js";

function keyOf(patch) {
    return patch.name?.trim() || patch.display_name?.trim() || "";
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function compatibility(patch) {
    return (patch.compatiblePackages || []).map(pkg => [pkg.name,
        [...new Set(pkg.versions || [])].sort()]).sort(([a], [b]) => a.localeCompare(b));
}

function optionSignature(option) {
    const { description: rawDescription, ...fields } = option;
    const description = formatPatchDescription(rawDescription);
    if (description) fields.description = description;
    return JSON.stringify(canonical(fields));
}

function fields(patch) {
    return {
        name: patch.display_name?.trim() || patchDisplayName(patch),
        description: formatPatchDescription(patch.description),
        compatibility: JSON.stringify([Boolean(patch.universal), compatibility(patch)]),
        options: JSON.stringify(renderablePatchOptions(patch.options).map(optionSignature).sort())
    };
}

function group(patches) {
    const groups = new Map();
    for (const patch of patches) {
        const key = keyOf(patch);
        if (!groups.has(key)) groups.set(key, []);
        const displayedFields = fields(patch);
        groups.get(key).push({ patch, fields: displayedFields, signature: JSON.stringify(displayedFields) });
    }
    return groups;
}

export function comparePatchLists(baseline, current) {
    const before = group(baseline), after = group(current);
    const result = { added: [], removed: [], changed: [] };
    for (const key of new Set([...before.keys(), ...after.keys()])) {
        const previous = before.get(key) || [];
        const next = [...(after.get(key) || [])];
        const unmatched = previous.filter(item => {
            const index = next.findIndex(candidate => item.signature === candidate.signature);
            if (index < 0) return true;
            next.splice(index, 1);
            return false;
        });
        // Pair changed entries only when there is a single unmatched patch on each side.
        if (key && unmatched.length === 1 && next.length === 1) {
            const [oldPatch] = unmatched, [newPatch] = next;
            result.changed.push({
                before: oldPatch.patch, after: newPatch.patch,
                fields: Object.keys(oldPatch.fields).filter(field => oldPatch.fields[field] !== newPatch.fields[field])
            });
        } else {
            result.removed.push(...unmatched.map(item => item.patch));
            result.added.push(...next.map(item => item.patch));
        }
    }
    const byName = (a, b) => patchDisplayName(a).localeCompare(patchDisplayName(b));
    result.added.sort(byName);
    result.removed.sort(byName);
    result.changed.sort((a, b) => byName(a.after, b.after));
    return result;
}

// Preserve the original whitespace and bound the work for unusually long descriptions.
export function wordDiff(before, after) {
    const left = before.match(/\S+\s*|\s+/gu) || [];
    const right = after.match(/\S+\s*|\s+/gu) || [];
    if (!left.length || !right.length || left.length * right.length > 40_000)
        return [{ kind: "removed", text: before }, { kind: "added", text: after }].filter(item => item.text);
    const scores = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
    for (let i = left.length - 1; i >= 0; i--) {
        for (let j = right.length - 1; j >= 0; j--) {
            scores[i][j] = left[i] === right[j] ? 1 + scores[i + 1][j + 1] :
                Math.max(scores[i + 1][j], scores[i][j + 1]);
        }
    }
    const result = [];
    const append = (kind, text) => {
        const last = result.at(-1);
        if (last?.kind === kind) last.text += text;
        else result.push({ kind, text });
    };
    let i = 0, j = 0;
    while (i < left.length || j < right.length) {
        if (i < left.length && j < right.length && left[i] === right[j]) {
            append("same", left[i++]);
            j++;
        } else if (i < left.length && (j === right.length || scores[i + 1][j] >= scores[i][j + 1])) {
            append("removed", left[i++]);
        } else {
            append("added", right[j++]);
        }
    }
    return result;
}
