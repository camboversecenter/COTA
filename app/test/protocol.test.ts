import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatAmount, toMinor, TYPES } from "../src/shared/protocol";

const SRC = join(__dirname, "../../contracts/src");

/** Every `keccak256("Type(...)")` typehash string declared in the contracts. */
function contractTypeStrings(): Set<string> {
  const out = new Set<string>();
  for (const f of readdirSync(SRC).filter((f) => f.endsWith(".sol"))) {
    const src = readFileSync(join(SRC, f), "utf8");
    for (const m of src.matchAll(/_TYPEHASH\s*=\s*keccak256\(\s*"([^"]+)"\s*\)/g)) out.add(m[1]);
  }
  return out;
}

describe("EIP-712 types", () => {
  const onChain = contractTypeStrings();
  for (const [name, fields] of Object.entries(TYPES)) {
    it(`${name} matches the contract typehash`, () => {
      const encoded = `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
      expect(onChain.has(encoded), `${encoded} not found in contracts/src`).toBe(true);
    });
  }
  it("covers every contract typehash", () => {
    expect(onChain.size).toBe(Object.keys(TYPES).length);
  });
});

describe("amounts", () => {
  it("always shows the ISO code", () => {
    expect(formatAmount(800, "USD")).toBe("8.00 USD");
    expect(formatAmount(20000, "KHR")).toBe("20,000 KHR");
  });
  it("converts to minor units", () => {
    expect(toMinor("8", "USD")).toBe(800);
    expect(toMinor("0.1", "USD")).toBe(10);
    expect(toMinor("20000", "KHR")).toBe(20000);
    expect(() => toMinor("0", "USD")).toThrow();
    expect(() => toMinor("abc", "KHR")).toThrow();
  });
});
