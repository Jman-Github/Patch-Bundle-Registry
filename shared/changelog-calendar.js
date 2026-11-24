import { countLabel } from "./site.js";
import { createFilterPicker } from "./source-picker.js";

function monthDate(month, day = 1) {
    const [year, number] = month.split("-").map(Number);
    return new Date(year, number - 1, day, 12);
}

export function calendarMonth(month, byDay) {
    const first = monthDate(month);
    const length = new Date(first.getFullYear(), first.getMonth() + 1, 0, 12).getDate();
    return {
        offset: first.getDay(),
        days: Array.from({ length }, (_, index) => {
            const number = index + 1;
            const key = month + "-" + String(number).padStart(2, "0");
            return { number, key, count: byDay.get(key)?.length ?? 0 };
        })
    };
}

export function renderChangelogCalendar(container, byDay, { state, dayFormat, renderEntry }) {
    const months = [...new Set([...byDay.keys()].filter(day => day !== "unknown")
        .map(day => day.slice(0, 7)))].sort().reverse();
    if (!months.length) return false;
    if (!months.includes(state.month)) state.month = months[0];

    const monthFormat = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", calendar: "gregory" });
    const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short" });
    const calendar = document.createElement("section");
    calendar.className = "changelog-calendar";
    calendar.setAttribute("aria-label", "Changelog calendar");
    calendar.innerHTML = `<div class="changelog-calendar-toolbar">
        <button id="changelog-older-month" class="view-toggle" type="button" aria-label="Previous month">‹</button>
        <div class="filter-field">
            <label class="visually-hidden" id="changelog-month-label" for="changelog-month">Month</label>
            <select id="changelog-month"></select>
            <button id="changelog-month-picker" class="filter-picker" type="button" hidden
                aria-labelledby="changelog-month-label changelog-month-value" aria-haspopup="dialog" aria-expanded="false">
                <span id="changelog-month-value" data-picker-value></span>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 9 6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
        </div>
        <button id="changelog-newer-month" class="view-toggle" type="button" aria-label="Next month">›</button>
    </div>
    <p class="changelog-calendar-key">Taller bars mark busier days this month</p>
    <div class="changelog-calendar-grid" data-weekdays aria-hidden="true"></div>
    <div class="changelog-calendar-grid" data-calendar-days role="group"></div>`;
    const selected = document.createElement("section");
    selected.className = "changelog-calendar-selection";
    selected.setAttribute("aria-labelledby", "changelog-selected-day-heading");
    selected.id = "changelog-selected-day";
    const heading = document.createElement("h2");
    heading.id = "changelog-selected-day-heading";
    heading.tabIndex = -1;
    const entries = document.createElement("div");
    entries.className = "release-day-entries";
    selected.append(heading, entries);
    container.append(calendar, selected);

    const select = calendar.querySelector("select");
    const pickerButton = calendar.querySelector("#changelog-month-picker");
    for (const month of months) select.add(new Option(monthFormat.format(monthDate(month)), month));
    const picker = createFilterPicker({ button: pickerButton, select, label: "Jump to a month", searchLabel: "Search months" });
    const older = calendar.querySelector("#changelog-older-month");
    const newer = calendar.querySelector("#changelog-newer-month");
    const weekdays = calendar.querySelector("[data-weekdays]");
    const grid = calendar.querySelector("[data-calendar-days]");
    const weekday = monthDate(state.month);
    weekday.setDate(weekday.getDate() - weekday.getDay());
    for (let day = 0; day < 7; day++) {
        const cell = document.createElement("span");
        cell.textContent = weekdayFormat.format(weekday);
        weekdays.append(cell);
        weekday.setDate(weekday.getDate() + 1);
    }

    function showDay() {
        const releases = byDay.get(state.day);
        selected.hidden = !releases;
        entries.replaceChildren();
        if (!releases) return;
        heading.textContent = dayFormat.format(releases[0].timestamp) + " · " + countLabel(releases.length, "changelog");
        entries.append(...releases.map(renderEntry));
    }

    function showMonth() {
        const index = months.indexOf(state.month);
        const focused = document.activeElement;
        older.disabled = index === months.length - 1;
        newer.disabled = index === 0;
        select.value = state.month;
        picker.sync();
        if ((focused === older && older.disabled) || (focused === newer && newer.disabled))
            (pickerButton.hidden ? select : pickerButton).focus({ preventScroll: true });
        grid.setAttribute("aria-label", monthFormat.format(monthDate(state.month)));
        const { offset, days } = calendarMonth(state.month, byDay);
        const counts = days.map(day => day.count).filter(Boolean);
        const max = Math.max(...counts), min = Math.min(...counts);
        const now = new Date();
        const today = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
            .map((part, index) => String(part).padStart(index ? 2 : 4, "0")).join("-");
        grid.replaceChildren();
        for (const day of days) {
            const cell = document.createElement(day.count ? "button" : "span");
            cell.className = "changelog-calendar-cell";
            if (day.number === 1) cell.style.gridColumnStart = offset + 1;
            if (day.key === today) cell.classList.add("changelog-calendar-today");
            else if (day.key > today) cell.classList.add("changelog-calendar-future");
            const number = document.createElement("span");
            number.className = "changelog-calendar-number";
            number.textContent = day.number;
            cell.append(number);
            if (day.count) {
                const label = dayFormat.format(byDay.get(day.key)[0].timestamp) + " · " + countLabel(day.count, "changelog");
                cell.id = "calendar-day-" + day.key;
                cell.type = "button";
                cell.setAttribute("aria-label", label);
                cell.title = label;
                cell.setAttribute("aria-controls", selected.id);
                cell.setAttribute("aria-pressed", String(state.day === day.key));
                const count = document.createElement("span");
                count.className = "changelog-calendar-count";
                count.textContent = day.count.toLocaleString();
                const activity = document.createElement("span");
                activity.className = "changelog-calendar-activity";
                // Scale across this month's range so busy and quiet days stay distinguishable.
                const activityLevel = max === min ? 1 : 0.15 + 0.85 * (day.count - min) / (max - min);
                activity.style.setProperty("--activity", activityLevel.toFixed(3));
                cell.append(count, activity);
                cell.addEventListener("click", () => {
                    grid.querySelector('[aria-pressed="true"]')?.setAttribute("aria-pressed", "false");
                    state.day = day.key;
                    cell.setAttribute("aria-pressed", "true");
                    showDay();
                    heading.focus({ preventScroll: true });
                    selected.scrollIntoView({ block: "nearest" });
                });
            } else cell.setAttribute("aria-hidden", "true");
            grid.append(cell);
        }
        showDay();
    }

    function changeMonth(month) {
        state.month = month;
        state.day = "";
        showMonth();
    }

    older.addEventListener("click", () => changeMonth(months[months.indexOf(state.month) + 1]));
    newer.addEventListener("click", () => changeMonth(months[months.indexOf(state.month) - 1]));
    select.addEventListener("change", () => changeMonth(select.value));
    if (!state.day.startsWith(state.month + "-") || !byDay.has(state.day)) state.day = "";
    showMonth();
    return true;
}
