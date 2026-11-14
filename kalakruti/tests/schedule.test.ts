import { describe, expect, it } from "vitest";
import { decide, nextReminderDate, stageDate } from "../lib/schedule";
import { addDays } from "../lib/dates";

const DUE = "2026-10-10";
const LEAD = 3;

function entry(overrides: Partial<Parameters<typeof decide>[0]> = {}) {
  return { status: "active" as const, due_date: DUE, stages_sent: 0, last_sent_on: null, ...overrides };
}

/** Simulate the daily job running every day in [from, to] and return send days. */
function simulate(from: string, to: string, skipDays: string[] = []) {
  let e = entry();
  const sends: Array<[string, number]> = [];
  let flaggedOn: string | null = null;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (skipDays.includes(d)) continue;
    const r = decide(e, d, LEAD);
    if (r.kind === "send") {
      sends.push([d, r.stage]);
      e = { ...e, stages_sent: r.stage, last_sent_on: d };
      if (r.stage === 4) {
        e = { ...e, status: "needs_attention" as never };
        flaggedOn = d;
      }
    }
  }
  return { sends, flaggedOn };
}

describe("stageDate", () => {
  it("maps the four stages exactly", () => {
    expect(stageDate(DUE, 1, 3)).toBe("2026-10-07");
    expect(stageDate(DUE, 2, 3)).toBe("2026-10-10");
    expect(stageDate(DUE, 3, 3)).toBe("2026-10-11");
    expect(stageDate(DUE, 4, 3)).toBe("2026-10-12");
  });
  it("respects configurable lead time", () => {
    expect(stageDate(DUE, 1, 2)).toBe("2026-10-08");
  });
});

describe("daily job", () => {
  it("sends exactly 4 reminders on the exact days, then flags", () => {
    const { sends, flaggedOn } = simulate("2026-10-01", "2026-10-31");
    expect(sends).toEqual([
      ["2026-10-07", 1],
      ["2026-10-10", 2],
      ["2026-10-11", 3],
      ["2026-10-12", 4],
    ]);
    expect(flaggedOn).toBe("2026-10-12");
  });

  it("catches up a missed day instead of skipping a stage", () => {
    const { sends } = simulate("2026-10-01", "2026-10-31", ["2026-10-10"]);
    expect(sends.map((s) => s[1])).toEqual([1, 2, 3, 4]);
    expect(sends[1]).toEqual(["2026-10-11", 2]);
    expect(sends[3]).toEqual(["2026-10-13", 4]);
  });

  it("never sends two reminders on the same day", () => {
    const e = entry({ stages_sent: 1, last_sent_on: "2026-10-11" });
    expect(decide(e, "2026-10-11", LEAD).kind).toBe("wait");
  });

  it("sends the pre-due reminder when entry is added inside the lead window", () => {
    expect(decide(entry(), "2026-10-09", LEAD)).toEqual({ kind: "send", stage: 1 });
  });

  it("does nothing for paused or paid entries", () => {
    expect(decide(entry({ status: "paused" }), "2026-10-10", LEAD).kind).toBe("skip");
    expect(decide(entry({ status: "paid" }), "2026-10-10", LEAD).kind).toBe("skip");
    expect(decide(entry({ status: "needs_attention" }), "2026-10-20", LEAD).kind).toBe("skip");
  });

  it("never goes past stage 4", () => {
    expect(decide(entry({ stages_sent: 4, last_sent_on: "2026-10-12" }), "2026-10-20", LEAD)).toEqual({
      kind: "flag",
    });
  });

  it("reports the next reminder date", () => {
    expect(nextReminderDate(entry(), LEAD)).toBe("2026-10-07");
    expect(nextReminderDate(entry({ stages_sent: 1, last_sent_on: "2026-10-07" }), LEAD)).toBe(DUE);
    expect(nextReminderDate(entry({ status: "paused" }), LEAD)).toBeNull();
  });
});
