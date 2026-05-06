import { describe, expect, it, vi } from "vitest";
import {
	decodeIdentity,
	formatTao,
	isLikelySs58,
	isValidWsUrl,
	mergeShares,
	parseBlockNumber,
	safeFloatToScaledBits,
	withLimit,
} from "./utils";

// Mimics the codec shape that @polkadot/api returns for U64F64 storage values.
const v1 = (bits: bigint) => ({ bits: { toBigInt: () => bits } });

// Mimics the codec shape for SafeFloat = { mantissa: U256, exponent: i64 }.
const v2 = (mantissa: bigint, exponent: number) => ({
	mantissa: { toString: () => mantissa.toString() },
	exponent: { toString: () => exponent.toString() },
});

const TWO_64 = 1n << 64n;

describe("formatTao", () => {
	it("formats zero", () => {
		expect(formatTao(0n)).toBe("0.000000");
	});

	it("formats exact 1 TAO (1e9 rao)", () => {
		expect(formatTao(1_000_000_000n)).toBe("1.000000");
	});

	it("formats fractional TAO", () => {
		expect(formatTao(1_500_000_000n)).toBe("1.500000");
		expect(formatTao(123_456_789n)).toBe("0.123456");
	});

	it("formats negative values", () => {
		expect(formatTao(-1_500_000_000n)).toBe("-1.500000");
	});

	it("respects precision argument", () => {
		expect(formatTao(1_123_456_789n, 2)).toBe("1.12");
		expect(formatTao(1_123_456_789n, 9)).toBe("1.123456789");
	});

	it("pads small fractions with zeros", () => {
		expect(formatTao(1_000_000n)).toBe("0.001000"); // 0.001 TAO
		expect(formatTao(1n)).toBe("0.000000"); // 1 rao → truncates at 6 decimals
	});
});

describe("withLimit", () => {
	it("returns empty array for empty input", async () => {
		const result = await withLimit([], 5, async (x) => x);
		expect(result).toEqual([]);
	});

	it("preserves input order", async () => {
		const items = [1, 2, 3, 4, 5];
		const result = await withLimit(items, 2, async (x) => x * 2);
		expect(result).toEqual([2, 4, 6, 8, 10]);
	});

	it("never runs more than `limit` tasks concurrently", async () => {
		let active = 0;
		let maxActive = 0;
		const items = Array.from({ length: 20 }, (_, i) => i);
		await withLimit(items, 3, async (x) => {
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise((r) => setTimeout(r, 5));
			active--;
			return x;
		});
		expect(maxActive).toBeLessThanOrEqual(3);
		expect(maxActive).toBe(3);
	});

	it("propagates rejection if any task throws", async () => {
		const items = [1, 2, 3, 4, 5];
		await expect(
			withLimit(items, 2, async (x) => {
				if (x === 3) throw new Error("boom");
				return x;
			}),
		).rejects.toThrow("boom");
	});

	it("calls onProgress with correct done/total", async () => {
		const onProgress = vi.fn();
		await withLimit([1, 2, 3], 2, async (x) => x, onProgress);
		const calls = onProgress.mock.calls;
		expect(calls).toHaveLength(3);
		expect(calls[calls.length - 1]).toEqual([3, 3]);
		// done must monotonically increase
		for (let i = 1; i < calls.length; i++) {
			expect(calls[i][0]).toBeGreaterThan(calls[i - 1][0]);
		}
	});

	it("handles limit > items.length", async () => {
		const result = await withLimit([1, 2], 100, async (x) => x + 10);
		expect(result).toEqual([11, 12]);
	});
});

describe("isLikelySs58", () => {
	it("accepts valid 48-char Substrate address", () => {
		expect(isLikelySs58("5Gb6x9SZQULGmFdFnx62GFH24WdcUQseo9pxiWpFwBPWqvyh")).toBe(true);
	});

	it("rejects empty / short / too long", () => {
		expect(isLikelySs58("")).toBe(false);
		expect(isLikelySs58("5Gb6x")).toBe(false);
		expect(isLikelySs58("5Gb6x9SZQULGmFdFnx62GFH24WdcUQseo9pxiWpFwBPWqvyh_extra_padding")).toBe(
			false,
		);
	});

	it("rejects characters outside base58 alphabet", () => {
		expect(isLikelySs58("5Gb6x9SZQULGmFdFnx62GFH24WdcUQseo9pxiWpFwBPW00O0")).toBe(false); // 0, O
		expect(isLikelySs58("5Gb6x9SZQULGmFdFnx62GFH24WdcUQseo9pxiWpFwBPW0IlI")).toBe(false); // I, l
	});

	it("trims whitespace before checking", () => {
		expect(isLikelySs58("  5Gb6x9SZQULGmFdFnx62GFH24WdcUQseo9pxiWpFwBPWqvyh  ")).toBe(true);
	});
});

describe("isValidWsUrl", () => {
	it("accepts ws:// and wss://", () => {
		expect(isValidWsUrl("ws://localhost:9944")).toBe(true);
		expect(isValidWsUrl("wss://subtensor-archive.app.minesight.co.uk")).toBe(true);
	});

	it("rejects http/https/empty", () => {
		expect(isValidWsUrl("")).toBe(false);
		expect(isValidWsUrl("http://example.com")).toBe(false);
		expect(isValidWsUrl("https://example.com")).toBe(false);
		expect(isValidWsUrl("subtensor-archive.app")).toBe(false);
	});
});

describe("parseBlockNumber", () => {
	it("parses valid positive integer", () => {
		expect(parseBlockNumber("7800000")).toBe(7800000);
		expect(parseBlockNumber("1")).toBe(1);
	});

	it("throws on garbage", () => {
		expect(() => parseBlockNumber("")).toThrow(/Invalid block number/);
		expect(() => parseBlockNumber("abc")).toThrow(/Invalid block number/);
		expect(() => parseBlockNumber("12.5")).toThrow(/Invalid block number/);
		expect(() => parseBlockNumber("0")).toThrow(/Invalid block number/);
		expect(() => parseBlockNumber("-5")).toThrow(/Invalid block number/);
	});
});

describe("safeFloatToScaledBits", () => {
	it("returns 0n for null / undefined / missing fields", () => {
		expect(safeFloatToScaledBits(null)).toBe(0n);
		expect(safeFloatToScaledBits(undefined)).toBe(0n);
		expect(safeFloatToScaledBits({})).toBe(0n);
	});

	it("returns 0n for zero mantissa", () => {
		expect(safeFloatToScaledBits(v2(0n, 5))).toBe(0n);
	});

	it("scales positive exponents correctly", () => {
		// value = 7 × 10^3 = 7000; scaled-bits = 7000 × 2^64
		expect(safeFloatToScaledBits(v2(7n, 3))).toBe(7000n * TWO_64);
	});

	it("scales negative exponents correctly", () => {
		// value = mantissa × 10^-3; with mantissa = 5 × 10^3 = 5000 → value = 5
		// → scaled-bits = 5 × 2^64
		expect(safeFloatToScaledBits(v2(5000n, -3))).toBe(5n * TWO_64);
	});

	it("preserves precision for normalized SafeFloat with very negative exponent", () => {
		// Realistic shape: mantissa close to U256_MAX (~1.158e77), exponent ~ -77.
		// SafeFloat normalization keeps mantissa in [SAFE_FLOAT_MAX/10, SAFE_FLOAT_MAX),
		// so for a real value of ~1.158 we get exponent = -77.
		const mantissa =
			115_792_089_237_316_195_423_570_985_008_687_907_853_269_984_665_640_564_039_457_584_007_913_129_639_935n; // U256_MAX
		const result = safeFloatToScaledBits(v2(mantissa, -77));
		// real_value = mantissa × 10^-77 ≈ 1.158
		// scaled = real_value × 2^64 ≈ 1.158 × 2^64
		expect(result).toBeGreaterThan(TWO_64);
		expect(result).toBeLessThan(2n * TWO_64);
	});

	it("returns 0n on malformed input (e.g. non-numeric mantissa)", () => {
		const bad = { mantissa: { toString: () => "not-a-number" }, exponent: { toString: () => "0" } };
		expect(safeFloatToScaledBits(bad)).toBe(0n);
	});
});

describe("mergeShares", () => {
	it("returns 0n when both V1 and V2 are zero / null", () => {
		expect(mergeShares(null, null)).toBe(0n);
		expect(mergeShares(v1(0n), v2(0n, 0))).toBe(0n);
	});

	it("falls back to V1 when V2 is null (pre-upgrade block)", () => {
		expect(mergeShares(v1(12345n), null)).toBe(12345n);
	});

	it("uses V1 when V2 is zero (key not yet migrated)", () => {
		expect(mergeShares(v1(99n), v2(0n, 5))).toBe(99n);
	});

	it("prefers V2 when it is non-zero (matches runtime alpha_iter_prefix semantics)", () => {
		// V2 says value = 1 → scaled-bits = 1 × 2^64. V1 has stale 7n bits.
		expect(mergeShares(v1(7n), v2(1n, 0))).toBe(TWO_64);
	});

	it("treats missing legacy V1 codec as 0n (not a throw)", () => {
		expect(mergeShares({}, v2(3n, 0))).toBe(3n * TWO_64);
		expect(mergeShares({}, null)).toBe(0n);
	});
});

describe("decodeIdentity", () => {
	it("returns null for null/undefined raw", () => {
		expect(decodeIdentity(null)).toBeNull();
		expect(decodeIdentity(undefined)).toBeNull();
	});

	it("returns null for None option", () => {
		expect(decodeIdentity({ isNone: true })).toBeNull();
	});

	it("unwraps Some option and extracts name", () => {
		const raw = {
			isNone: false,
			isSome: true,
			unwrap: () => ({
				name: { toHuman: () => "Kiln" },
				url: { toHuman: () => "https://kiln.fi" },
			}),
		};
		expect(decodeIdentity(raw)).toEqual({ name: "Kiln", url: "https://kiln.fi" });
	});

	it("reads bare identity (no Option wrapper)", () => {
		const raw = {
			name: { toHuman: () => "TAO.com" },
			githubRepo: { toHuman: () => "" }, // empty string → skipped
		};
		expect(decodeIdentity(raw)).toEqual({ name: "TAO.com" });
	});

	it("returns null when no fields populated", () => {
		const raw = {
			name: { toHuman: () => "" },
			url: { toHuman: () => "" },
		};
		expect(decodeIdentity(raw)).toBeNull();
	});

	it("swallows exceptions while reading fields", () => {
		const raw = {
			name: {
				toHuman: () => {
					throw new Error("bad codec");
				},
			},
			url: { toHuman: () => "https://ok" },
		};
		expect(decodeIdentity(raw)).toEqual({ url: "https://ok" });
	});
});
