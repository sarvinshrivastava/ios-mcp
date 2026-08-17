/**
 * uitree.test.ts — pure-function tests against fixture WDA /source dumps.
 * Fixtures model a React Native screen: nav bar, scroll view, cells with
 * nested StaticTexts, testID-named buttons, a TextField, invisible/offscreen
 * elements, and deep XCUIElementTypeOther wrapper chains.
 */

import { describe, expect, test } from "bun:test";
import rnHome from "./fixtures/rn-home.json";
import noNavbar from "./fixtures/no-navbar.json";
import sparseCanvas from "./fixtures/sparse-canvas.json";
import {
  cleanLabel,
  clipLabel,
  condenseTree,
  matchElements,
  nearestLabels,
  screenSignature,
  screenTitle,
  type UiElement,
} from "../src/uitree.ts";

const snap = condenseTree(rnHome);
const byId = (id: string): UiElement => {
  const el = snap.elements.find((e) => e.id === id);
  if (!el) throw new Error(`fixture element missing: ${id}`);
  return el;
};

describe("condenseTree — grouping", () => {
  test("folds nested StaticTexts into their Cell", () => {
    expect(byId("workout-card-1").label).toBe(
      "Morning Yoga · 21 days — Beginner",
    );
    expect(byId("workout-card-2").label).toBe("Evening Stretch · 14 days");
  });

  test("dedupes a button's own label against its inner StaticText", () => {
    expect(byId("start-workout-button").label).toBe("Start Workout");
  });

  test("drops redundant label-less wrappers around an interactive", () => {
    // cta-wrapper (Other with testID) wraps the Start Workout button.
    expect(snap.elements.some((e) => e.id === "cta-wrapper")).toBe(false);
    // Deep Other chains (window/screen containers) never surface either.
    expect(snap.elements.some((e) => e.id === "home-screen")).toBe(false);
    expect(snap.elements.some((e) => e.type === "Other")).toBe(false);
  });

  test("keeps orphan text on its own", () => {
    const version = snap.elements.find((e) => e.label === "Version 1.2.3");
    expect(version?.role).toBe("text");
    expect(version?.interactive).toBe(false);
  });

  test("grouping collapsed nodes (ungroupedCount > elements)", () => {
    expect(snap.ungroupedCount).toBeGreaterThan(snap.elements.length);
    expect(snap.rawNodeCount).toBeGreaterThan(snap.ungroupedCount);
  });

  test("elements come out in reading order (top-to-bottom, left-to-right)", () => {
    const ys = snap.elements.map((e) => e.bounds.y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
  });

  test("center is the bounds midpoint in points", () => {
    const start = byId("start-workout-button");
    expect(start.bounds).toEqual({ x: 16, y: 310, w: 358, h: 48 });
    expect(start.center).toEqual({ x: 195, y: 334 });
  });
});

describe("condenseTree — role mapping", () => {
  test("Button/Cell → button", () => {
    expect(byId("start-workout-button").role).toBe("button");
    expect(byId("workout-card-1").role).toBe("button");
    expect(byId("back-button").role).toBe("button");
  });

  test("TextField → input", () => {
    expect(byId("email-input").role).toBe("input");
    expect(byId("email-input").value).toBe("user@example.com");
  });

  test("Switch → switch", () => {
    expect(byId("notifications-toggle").role).toBe("switch");
  });

  test("Image → image", () => {
    expect(byId("hero-image").role).toBe("image");
  });

  test("StaticText → text", () => {
    const t = snap.elements.find((e) => e.label === "How to play tutorial");
    expect(t?.role).toBe("text");
  });

  test("disabled elements are kept, flagged enabled=false", () => {
    const cont = byId("continue-button");
    expect(cont.enabled).toBe(false);
    expect(cont.role).toBe("button");
  });
});

describe("condenseTree — visibility", () => {
  test('excludes isVisible "0" (string form)', () => {
    expect(snap.elements.some((e) => e.id === "hidden-cta")).toBe(false);
  });

  test("excludes isVisible false (boolean form)", () => {
    expect(snap.elements.some((e) => e.label === "Offscreen text")).toBe(false);
  });

  test("handles boolean and string truthy forms alike", () => {
    // Fixture mixes isVisible: "1" and true; both survive.
    expect(byId("back-button")).toBeDefined(); // "1"
    const home = snap.elements.find((e) => e.label === "Home");
    expect(home).toBeDefined(); // true
  });
});

describe("sparse flag", () => {
  test("rich RN screen is not sparse", () => {
    expect(snap.sparse).toBe(false);
  });

  test("canvas/game screen with no actionable elements is sparse", () => {
    const canvas = condenseTree(sparseCanvas);
    expect(canvas.elements.length).toBe(0);
    expect(canvas.sparse).toBe(true);
  });
});

describe("matchElements — selector semantics", () => {
  test("exact label match ranks above substring match", () => {
    const res = matchElements(snap.elements, { text: "Play" });
    expect(res.length).toBe(2); // "Play" button + "How to play tutorial"
    expect(res[0]!.id).toBe("play-button");
  });

  test("exact match works on merged label segments", () => {
    const res = matchElements(snap.elements, { text: "Evening Stretch" });
    expect(res[0]!.id).toBe("workout-card-2");
  });

  test("id matches accessibility identifier (testID), exact and suffix", () => {
    expect(matchElements(snap.elements, { id: "email-input" })[0]!.role).toBe(
      "input",
    );
    const suffix = matchElements(snap.elements, { id: "card-1" });
    expect(suffix.length).toBe(1);
    expect(suffix[0]!.id).toBe("workout-card-1");
  });

  test("type matches role and raw XCUIElementType name", () => {
    const inputs = matchElements(snap.elements, { type: "input" });
    expect(inputs.length).toBe(1);
    expect(inputs[0]!.id).toBe("email-input");
    expect(matchElements(snap.elements, { type: "TextField" })[0]!.id).toBe(
      "email-input",
    );
    expect(
      matchElements(snap.elements, { type: "button" }).length,
    ).toBeGreaterThan(3);
  });

  test("text matches against value (typed field contents)", () => {
    const res = matchElements(snap.elements, { text: "user@example.com" });
    expect(res[0]!.id).toBe("email-input");
  });

  test("selector fields AND together", () => {
    const res = matchElements(snap.elements, {
      text: "Start Workout",
      type: "button",
    });
    expect(res[0]!.id).toBe("start-workout-button");
    expect(
      matchElements(snap.elements, { text: "Workout", type: "input" }),
    ).toEqual([]);
  });

  test("no match → empty array", () => {
    expect(matchElements(snap.elements, { text: "does-not-exist" })).toEqual(
      [],
    );
  });
});

describe("labels — cleaning and 80-char clip", () => {
  test("labels stay FULL for matching, even past 80 chars", () => {
    const long = snap.elements.find((e) => e.label.includes("ZANZIBAR"));
    expect(long).toBeDefined();
    expect(long!.label.length).toBeGreaterThan(80);
    // Matching uses the full text — the needle lives past char 80.
    expect(matchElements(snap.elements, { text: "ZANZIBAR" })[0]).toBe(long!);
  });

  test("clipLabel clips output to 80 chars with ellipsis", () => {
    const long = snap.elements.find((e) => e.label.includes("ZANZIBAR"))!;
    const clipped = clipLabel(long.label);
    expect(clipped.length).toBeLessThanOrEqual(81); // 80 + ellipsis
    expect(clipped.endsWith("…")).toBe(true);
    expect(clipped.includes("ZANZIBAR")).toBe(false);
    expect(clipLabel("short")).toBe("short");
  });

  test("cleanLabel strips assistive-tech noise, keeps real text", () => {
    expect(cleanLabel("double tap to view Hotlist")).toBe("view Hotlist");
    expect(cleanLabel("Money Tab 2 of 3")).toBe("Money");
    expect(cleanLabel("Submit, button")).toBe("Submit");
    expect(cleanLabel("All filter, , selected")).toBe("All filter, selected");
    expect(cleanLabel("  spaced   out  ")).toBe("spaced out");
    expect(cleanLabel("Network & internet")).toBe("Network & internet");
  });
});

describe("nearestLabels", () => {
  test("suggests the closest on-screen labels for a typo'd selector", () => {
    const near = nearestLabels(snap.elements, { text: "Strat Workout" }, 3);
    expect(near[0]).toBe("Start Workout");
  });

  test("works off id selectors too", () => {
    const near = nearestLabels(snap.elements, { id: "email-inptu" }, 5);
    expect(near).toContain("Email");
  });

  test("clips suggested labels and caps at n", () => {
    const near = nearestLabels(snap.elements, { text: "zz" }, 2);
    expect(near.length).toBeLessThanOrEqual(2);
    for (const l of near) expect(l.length).toBeLessThanOrEqual(81);
  });
});

describe("screenSignature", () => {
  test("same tree → same hash", () => {
    expect(screenSignature(rnHome)).toBe(
      screenSignature(structuredClone(rnHome)),
    );
  });

  test("changed ids → changed hash", () => {
    const mutated = structuredClone(rnHome) as any;
    // rn-home: value → app → window → other → home-screen → [navbar, scroll]
    const scroll =
      mutated.value.children[0].children[0].children[0].children[1];
    const cell = scroll.children[0].children[0];
    expect(cell.name).toBe("workout-card-1");
    cell.name = "workout-card-99";
    expect(screenSignature(mutated)).not.toBe(screenSignature(rnHome));
  });

  test("different screens hash differently", () => {
    expect(screenSignature(rnHome)).not.toBe(screenSignature(noNavbar));
  });

  test("label-only changes do not flap the signature", () => {
    const mutated = structuredClone(rnHome) as any;
    const scroll =
      mutated.value.children[0].children[0].children[0].children[1];
    const text = scroll.children[0].children[0].children[0].children[0];
    expect(text.label).toBe("Morning Yoga");
    text.label = "Evening Yoga";
    text.value = "Evening Yoga";
    expect(screenSignature(mutated)).toBe(screenSignature(rnHome));
  });
});

describe("screenTitle", () => {
  test("uses the navigation bar title when present", () => {
    expect(screenTitle(rnHome)).toBe("Home");
  });

  test("falls back to topmost prominent StaticText without a nav bar", () => {
    expect(screenTitle(noNavbar)).toBe("Welcome back");
  });

  test("undefined when nothing title-like exists", () => {
    expect(screenTitle(sparseCanvas)).toBeUndefined();
  });
});

describe("input robustness", () => {
  test("accepts both the raw HTTP body ({value: tree}) and the bare tree", () => {
    const bare = (rnHome as any).value;
    expect(condenseTree(bare).elements.length).toBe(snap.elements.length);
    expect(screenSignature(bare)).toBe(screenSignature(rnHome));
  });

  test("full-screen Other with a testID is not treated as a tap target", () => {
    // "home-screen" covers 100% of the root — if it counted as interactive it
    // would swallow every orphan text on screen.
    const version = snap.elements.find((e) => e.label === "Version 1.2.3");
    expect(version).toBeDefined();
  });

  test("empty/garbage input degrades to an empty sparse tree", () => {
    for (const junk of [null, undefined, {}, { value: null }]) {
      const res = condenseTree(junk);
      expect(res.elements).toEqual([]);
      expect(res.sparse).toBe(true);
    }
    expect(screenTitle(null)).toBeUndefined();
    expect(typeof screenSignature(null)).toBe("string");
  });
});
