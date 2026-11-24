export function matchingOptions(options, query) {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return options.filter(option => terms.every(term =>
        (option.label + " " + option.value).toLowerCase().includes(term)));
}

// The native control holds the filter value and provides a fallback for older browsers.
export function createFilterPicker({ button, select, label, searchLabel, showValue = false, reselect = false }) {
    const value = button.querySelector("[data-picker-value]");
    if (typeof button.showPopover !== "function") {
        return { sync() {} };
    }
    const panel = document.createElement("div");
    panel.id = button.id + "-options";
    panel.className = "filter-popover";
    panel.popover = "auto";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", label);
    const search = searchLabel ? document.createElement("input") : null;
    if (search) {
        search.type = "search";
        search.className = "details-search";
        search.placeholder = searchLabel;
        search.setAttribute("aria-label", searchLabel);
        search.autocomplete = "off";
        panel.append(search);
    }
    const list = document.createElement("div");
    list.className = "filter-options";
    const message = document.createElement("p");
    message.className = "filter-empty";
    message.setAttribute("role", "status");
    panel.append(list, message);
    button.after(panel);
    button.setAttribute("aria-controls", panel.id);
    const associatedLabels = [...select.labels];
    for (const associatedLabel of associatedLabels) associatedLabel.htmlFor = button.id;
    select.hidden = true;
    button.hidden = false;
    let choices = [];
    let pointerStartedOpen = false;
    const isOpen = () => panel.matches(":popover-open");

    function position() {
        const rect = button.getBoundingClientRect();
        const viewport = window.visualViewport;
        const x = viewport?.offsetLeft || 0, y = viewport?.offsetTop || 0;
        const width = viewport?.width || document.documentElement.clientWidth;
        const height = viewport?.height || document.documentElement.clientHeight;
        const edge = 8, gap = 6, bottom = y + height;
        if (rect.bottom <= y || rect.top >= bottom) {
            panel.hidePopover();
            return;
        }
        const minWidth = showValue ? 320 : search ? 260 : 200;
        const panelWidth = Math.min(Math.max(rect.width, minWidth), width - 2 * edge);
        const below = bottom - rect.bottom - gap - edge;
        const above = rect.top - y - gap - edge;
        panel.style.width = panelWidth + "px";
        const toolbarHeight = search ? search.offsetHeight + 6 : 0;
        const targetHeight = Math.min(toolbarHeight + Math.max(list.scrollHeight, message.offsetHeight) + 14, 360);
        const upwards = below < targetHeight && above > below;
        panel.style.left = Math.max(x + edge, Math.min(rect.left, x + width - panelWidth - edge)) + "px";
        panel.style.maxHeight = Math.max(0, Math.min(360, upwards ? above : below)) + "px";
        panel.style.top = upwards ? "auto" : rect.bottom + gap + "px";
        panel.style.bottom = upwards ? document.documentElement.clientHeight - rect.top + gap + "px" : "auto";
    }

    function revealChoice(choice) {
        if (!choice) return;
        const viewport = list.getBoundingClientRect(), row = choice.getBoundingClientRect();
        if (row.top < viewport.top) list.scrollTop -= viewport.top - row.top;
        if (row.bottom > viewport.bottom) list.scrollTop += row.bottom - viewport.bottom;
    }

    function focusChoice(choice) {
        choices.forEach(item => { item.tabIndex = item === choice ? 0 : -1; });
        choice?.focus({ preventScroll: true });
        revealChoice(choice);
    }

    function render() {
        const focused = list.contains(document.activeElement) ? document.activeElement.dataset.value : undefined;
        const query = search?.value || "";
        const matches = matchingOptions([...select.options].filter(option => !option.disabled), query);
        choices = matches.map(option => {
            const choice = document.createElement("button");
            choice.type = "button";
            choice.className = "filter-option";
            choice.dataset.value = option.value;
            choice.setAttribute("aria-pressed", String(option.value === select.value));
            const name = document.createElement("span");
            name.textContent = option.label;
            choice.append(name);
            if (showValue && option.value) {
                const detail = document.createElement("small");
                detail.textContent = option.value;
                choice.append(detail);
            }
            return choice;
        });
        const selected = choices.find(item => item.dataset.value === select.value) || choices[0];
        choices.forEach(item => { item.tabIndex = item === selected ? 0 : -1; });
        list.replaceChildren(...choices);
        message.hidden = choices.length > 0;
        message.textContent = choices.length ? "" : "No matching options.";
        if (focused !== undefined) {
            const next = choices.find(item => item.dataset.value === focused);
            if (next) focusChoice(next);
            else search?.focus({ preventScroll: true });
        }
        position();
    }

    function sync() {
        value.textContent = select.selectedOptions[0]?.label ?? select.options[0]?.label ?? "";
        if (select.disabled && isOpen()) panel.hidePopover();
        button.disabled = select.disabled;
        if (isOpen()) render();
    }

    function open(preferOption = false) {
        if (search) search.value = "";
        panel.showPopover();
        render();
        if (!isOpen()) return;
        const selected = choices.find(item => item.tabIndex === 0);
        if (search && !preferOption && !matchMedia("(pointer: coarse)").matches) {
            search.focus({ preventScroll: true });
            revealChoice(selected);
        } else {
            focusChoice(selected);
        }
    }

    function closeAndFocus() {
        if (isOpen()) panel.hidePopover();
        button.focus({ preventScroll: true });
    }

    // Light dismissal can close the panel before the trigger or label's click runs.
    for (const trigger of [button, ...associatedLabels]) {
        trigger.addEventListener("pointerdown", event => {
            if (event.button === 0) pointerStartedOpen = isOpen();
        });
    }
    button.addEventListener("click", event => {
        const shouldClose = isOpen() || (event.detail > 0 && pointerStartedOpen);
        pointerStartedOpen = false;
        if (shouldClose) closeAndFocus();
        else open();
    });
    button.addEventListener("keydown", event => {
        if (event.key === "Escape" && isOpen()) {
            event.preventDefault();
            event.stopPropagation();
            closeAndFocus();
            return;
        }
        if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
        event.preventDefault();
        if (!isOpen()) open(true);
    });
    panel.addEventListener("beforetoggle", event =>
        button.setAttribute("aria-expanded", String(event.newState === "open")));
    const viewportTargets = [[window, "resize"], [window.visualViewport, "resize"], [window.visualViewport, "scroll"]];
    function trackViewport(open) {
        if (open) document.addEventListener("scroll", onScroll, { capture: true, passive: true });
        else document.removeEventListener("scroll", onScroll, true);
        for (const [target, name] of viewportTargets) {
            if (open) target?.addEventListener(name, reposition, { passive: true });
            else target?.removeEventListener(name, reposition);
        }
    }
    // Removing an open popover hides it without a toggle event, so detach here too.
    function detached() {
        if (panel.isConnected) return false;
        trackViewport(false);
        return true;
    }
    function reposition() { if (!detached() && isOpen()) position(); }
    function onScroll(event) {
        if (detached() || !isOpen()) return;
        if (event.target === document) position();
        else if (event.target.contains?.(button)) panel.hidePopover();
    }
    panel.addEventListener("toggle", () => trackViewport(isOpen()));
    panel.addEventListener("focusout", event => {
        if (!panel.contains(event.relatedTarget) && event.relatedTarget !== button && isOpen()) panel.hidePopover();
    });
    panel.addEventListener("keydown", event => {
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            closeAndFocus();
            return;
        }
        const index = choices.indexOf(event.target);
        const fromSearch = event.target === search;
        const destination = {
            ArrowDown: index < 0 ? 0 : Math.min(index + 1, choices.length - 1),
            ArrowUp: index < 0 ? choices.length - 1 : Math.max(index - 1, 0),
            Home: fromSearch ? -1 : 0,
            End: fromSearch ? -1 : choices.length - 1
        }[event.key];
        if (destination >= 0 && choices.length) {
            event.preventDefault();
            if (search && index === 0 && event.key === "ArrowUp") search.focus({ preventScroll: true });
            else focusChoice(choices[destination]);
        }
    });
    search?.addEventListener("input", () => {
        list.scrollTop = 0;
        render();
    });
    list.addEventListener("click", event => {
        const choice = event.target.closest("button");
        if (!choice) return;
        const previous = select.value;
        select.value = choice.dataset.value;
        closeAndFocus();
        sync();
        if (select.value !== previous || reselect) select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    sync();
    return { sync };
}
