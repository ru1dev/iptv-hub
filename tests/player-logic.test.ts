import { describe, it, expect } from "vitest";
import { neighborIndex, shouldRetryNetwork, skipTarget } from "../src/player";

describe("shouldRetryNetwork", () => {
  it("даёт несколько попыток восстановиться", () => {
    expect(shouldRetryNetwork(1)).toBe(true);
    expect(shouldRetryNetwork(3)).toBe(true);
  });
  it("сдаётся после предела — иначе мёртвый поток переподключается вечно", () => {
    expect(shouldRetryNetwork(4)).toBe(false);
    expect(shouldRetryNetwork(99)).toBe(false);
  });
});

describe("neighborIndex (prev/next channel)", () => {
  it("returns null for an empty list", () => {
    expect(neighborIndex(0, 0, 1)).toBeNull();
  });

  it("steps forward and wraps around", () => {
    expect(neighborIndex(0, 5, 1)).toBe(1);
    expect(neighborIndex(4, 5, 1)).toBe(0);
  });

  it("steps backward and wraps around", () => {
    expect(neighborIndex(2, 5, -1)).toBe(1);
    expect(neighborIndex(0, 5, -1)).toBe(4);
  });

  it("handles single-element list", () => {
    expect(neighborIndex(0, 1, 1)).toBe(0);
    expect(neighborIndex(0, 1, -1)).toBe(0);
  });
});

describe("skipTarget (±15s seek)", () => {
  it("returns null for live streams", () => {
    expect(skipTarget(10, -15, 0, true)).toBeNull();
    expect(skipTarget(10, 15, Infinity, true)).toBeNull();
  });

  it("clamps to [0, duration]", () => {
    expect(skipTarget(5, -15, 600, false)).toBe(0);
    expect(skipTarget(595, 15, 600, false)).toBe(600);
  });

  it("moves by delta within bounds", () => {
    expect(skipTarget(100, 15, 600, false)).toBe(115);
    expect(skipTarget(100, -15, 600, false)).toBe(85);
  });

  it("handles NaN currentTime", () => {
    expect(skipTarget(NaN, 15, 600, false)).toBeNull();
  });
});
