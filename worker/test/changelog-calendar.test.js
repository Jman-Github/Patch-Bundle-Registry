import assert from "node:assert/strict";
import test from "node:test";
import { calendarMonth } from "../../shared/changelog-calendar.js";

test("The changelog calendar places February's leap day and retains its exact activity count", () => {
    const dates = new Map([
        ["2024-02-01", [{}]],
        ["2024-02-29", [{}, {}, {}]],
        ["2024-03-01", [{}]]
    ]);
    const { offset, days } = calendarMonth("2024-02", dates);
    assert.equal(offset, 4);
    assert.equal(days.length, 29);
    assert.deepEqual(days[0], { number: 1, key: "2024-02-01", count: 1 });
    assert.deepEqual(days[1], { number: 2, key: "2024-02-02", count: 0 });
    assert.deepEqual(days.at(-1), { number: 29, key: "2024-02-29", count: 3 });
    assert.equal(calendarMonth("2025-02", dates).days.length, 28);
});
