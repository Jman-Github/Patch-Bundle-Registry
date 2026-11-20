// Shared accessible icon actions for cards and detail dialogs.
const paths = {
    download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
    link: '<path d="m10 13 4-4m-7 7-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m0 7a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-1 1" transform="translate(2 2) scale(.85)"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M15 8V4H4v11h4"/>',
    repository: '<path d="M5 3h14v18H5zM8 7h8M8 11h8M8 15h4"/>',
    signature: '<path d="m12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7zM8 12l3 3 5-6"/>'
};
export function iconAction(kind, label, escape, {href, copy, disabled = false} = {}) {
    const tag = href ? "a" : "button";
    const target = href ? `href="${escape(href)}" target="_blank" rel="noopener noreferrer"` :
        `type="button" ${disabled ? "disabled" : ""} data-copy-text="${escape(copy ?? "")}"`;
    return `<${tag} class="icon-action" ${target} aria-label="${escape(label)}" data-tooltip="${escape(label)}">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[kind]}</svg>
        <span class="action-tooltip" aria-hidden="true">${escape(label)}</span></${tag}>`;
}

/** Reseam releases support two import contracts; keep the choice local to this card. */
export function importFormatAction(escape, registryUrl, reseamUrl, registryDisabled = false) {
    const choices = [
        ["Registry URL (URV)", registryUrl, registryDisabled],
        ["Reseam Manager JSON", reseamUrl, false]
    ];
    return `<span class="copy-format-menu">
        <button type="button" class="icon-action copy-format-trigger"
            aria-expanded="false" aria-label="Choose import link format" data-tooltip="Choose import link format">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths.link}</svg>
            <span class="action-tooltip" aria-hidden="true">Choose import link format</span>
        </button>
        <span class="copy-format-options" role="group" aria-label="Import link format" hidden>
            ${choices.map(([label, url, disabled]) => `<button type="button" class="icon-action copy-format-option"
                data-copy-text="${escape(url)}" data-tooltip="Copy ${escape(label)}"
                aria-label="Copy ${escape(label)}" ${disabled ? "disabled" : ""}>${escape(label)}
                <span class="action-tooltip" aria-hidden="true">Copy ${escape(label)}</span></button>`).join("")}
        </span>
    </span>`;
}
export function bindActions(container) {
    const showFeedback = new Map();
    container.querySelectorAll(".copy-format-trigger").forEach(trigger => {
        if (!trigger.classList?.contains?.("copy-format-trigger")) return;
        trigger.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            const options = trigger.parentElement.querySelector(".copy-format-options");
            options.hidden = !options.hidden;
            trigger.setAttribute("aria-expanded", String(!options.hidden));
        });
        trigger.parentElement.addEventListener("focusout", event => {
            if (trigger.parentElement.contains(event.relatedTarget)) return;
            trigger.parentElement.querySelector(".copy-format-options").hidden = true;
            trigger.setAttribute("aria-expanded", "false");
        });
        // Escape must also work after keyboard focus moves into a copy option.
        trigger.parentElement.addEventListener("keydown", event => {
            if (event.key !== "Escape") return;
            const options = trigger.parentElement.querySelector(".copy-format-options");
            if (options.hidden) return;
            event.preventDefault();
            event.stopPropagation();
            options.hidden = true;
            trigger.setAttribute("aria-expanded", "false");
            trigger.focus();
        });
    });
    container.querySelectorAll(".icon-action").forEach(action => {
        let holdTimer, hideTimer, held = false;
        const clearHold = () => clearTimeout(holdTimer);
        const placeTooltip = () => {
            // Virtual rows are transformed; card labels stay relative to their buttons.
            if (!action.closest?.("dialog")) return;
            const rect = action.getBoundingClientRect?.();
            if (!rect) return;
            const tip = action.querySelector(".action-tooltip");
            // Fixed positioning keeps labels outside scrolling/overflow clips.
            tip.style.position = "fixed";
            tip.style.right = "auto";
            tip.style.width = "max-content";
            tip.style.maxWidth = Math.min(280, window.innerWidth - 16) + "px";
            tip.style.whiteSpace = "normal";
            const size = tip.getBoundingClientRect();
            tip.style.left = Math.max(8, Math.min(rect.right - size.width, window.innerWidth - size.width - 8)) + "px";
            tip.style.top = Math.max(8, rect.bottom + size.height + 12 <= window.innerHeight
                ? rect.bottom + 6 : rect.top - size.height - 6) + "px";
        };
        showFeedback.set(action, message => {
            const tip = action.querySelector(".action-tooltip");
            tip.textContent = message;
            action.classList.add("tooltip-visible");
            placeTooltip();
            clearTimeout(hideTimer);
            hideTimer = setTimeout(() => {
                tip.textContent = action.dataset.tooltip;
                action.classList.remove("tooltip-visible");
            }, 1800);
        });
        action.addEventListener("pointerenter", placeTooltip);
        action.addEventListener("focus", placeTooltip);
        action.addEventListener("pointerdown", event => {
            if (event.pointerType === "mouse") return;
            held = false;
            clearTimeout(hideTimer);
            holdTimer = setTimeout(() => {
                held = true;
                action.classList.add("tooltip-visible");
                placeTooltip();
            }, 500);
        });
        action.addEventListener("pointerup", () => {
            clearHold();
            hideTimer = setTimeout(() => action.classList.remove("tooltip-visible"), 1800);
        });
        action.addEventListener("pointercancel", () => {
            clearHold(); held = false; action.classList.remove("tooltip-visible");
        });
        action.addEventListener("pointerleave", clearHold);
        action.addEventListener("contextmenu", event => { if (held) event.preventDefault(); });
        action.addEventListener("click", event => {
            if (!held) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            held = false;
        }, true);
        action.addEventListener("click", async event => {
            event.stopPropagation();
            if (!action.hasAttribute("data-copy-text")) return;
            event.preventDefault();
            let target = action;
            let message;
            try { await navigator.clipboard.writeText(action.dataset.copyText); message = "Copied!"; }
            catch { message = "Unable to copy"; }
            if (message === "Copied!" && action.classList.contains?.("copy-format-option")) {
                const menu = action.closest(".copy-format-menu");
                menu.querySelector(".copy-format-options").hidden = true;
                const trigger = menu.querySelector(".copy-format-trigger");
                trigger.setAttribute("aria-expanded", "false");
                trigger.focus();
                target = trigger;
            }
            (showFeedback.get(target) || showFeedback.get(action))(message);
            const status = action.closest?.("dialog")?.querySelector("[data-copy-status]") ||
                globalThis.document?.querySelector("[data-copy-status]");
            status?.replaceChildren(message);
        });
    });
}

