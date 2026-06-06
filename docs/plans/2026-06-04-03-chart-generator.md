# Chart Generator Implementation Plan (plan 03)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** A pure, dependency-free SVG chart generator in the Oracle house style, with the global SVG guideline's "everything inside the frame" rule encoded as a testable invariant. Ports the Northwind business-case charts (annual cost comparison; 5-year cumulative with payback).

**Architecture:** `src/charts/svg.ts` is a tiny builder that accumulates SVG primitives AND tracks a content bounding box (so `withinFrame()` can assert nothing overflows). It implements the house-style marker + step-over (`hop`) arcs. `src/charts/costChart.ts` and `src/charts/fiveYearChart.ts` are pure `data → svg string` functions. No I/O, no LLM.

**Tech Stack:** TypeScript, Vitest (same as prior plans).

---

### Task 1: SVG builder with bounds tracking + step-over + invariant
**Files:** Create `src/charts/svg.ts`, `src/charts/svg.test.ts`

- [ ] Write failing tests (see `svg.test.ts` below): rect/line/text/circle update bounds; `hop` emits an arc when crossing; `withinFrame` true/false; `toString` includes viewBox + white bg + marker.
- [ ] Run red → implement `Svg` class + `withinFrame` + `textWidth` → run green → commit.

### Task 2: Cost comparison chart
**Files:** Create `src/charts/costChart.ts`, `src/charts/costChart.test.ts`

- [ ] Failing test: `renderCostChart(data)` returns SVG containing the title, each bar total, RTO/RPO labels; and the geometry invariant `withinFrame` holds. → red → implement → green → commit.

### Task 3: Five-year cumulative chart
**Files:** Create `src/charts/fiveYearChart.ts`, `src/charts/fiveYearChart.test.ts`

- [ ] Failing test: `renderFiveYearChart(data)` returns SVG with both series, the payback marker, the savings callout; `withinFrame` holds. → red → implement → green → commit.

## Self-Review
- Encodes SVG guideline rule #1 (in-frame) as `withinFrame` invariant tested on every chart.
- House-style: Oracle palette, Segoe UI, `context-stroke` marker, step-over arcs — consistent with `~/.claude/svg-guidelines.md` and the Northwind figures.
- Pure functions; orchestrator (later plan) wires engine output → chart data.
