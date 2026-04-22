import { describe, expect, it } from "vitest";
import {
	computeBalance,
	computePassiveDividend,
	computePoolApyPct,
	computeRealizedDividend,
	type SampleForMath,
} from "./math";
import { SHARE_COEF } from "./utils";

// Helper: makes a plausible (totalAlpha, totalShares) pair at a given "per-share value".
// psv = totalAlpha / totalShares (conceptually). We pin totalShares and pick totalAlpha.
function pool(totalSharesBits: bigint, totalAlphaRao: bigint) {
	return { totalAlpha: totalAlphaRao, totalShares: totalSharesBits };
}

describe("computeBalance", () => {
	it("returns 0 when pool has no shares", () => {
		expect(computeBalance(0n, 0n, 0n)).toBe(0n);
		expect(computeBalance(100n * SHARE_COEF, 0n, 1_000_000_000n)).toBe(0n);
	});

	it("gives user the whole pool when they own 100% of shares", () => {
		const shares = 5n * SHARE_COEF;
		const totalAlpha = 1_000_000_000n; // 1 α
		expect(computeBalance(shares, shares, totalAlpha)).toBe(totalAlpha);
	});

	it("scales linearly with share fraction", () => {
		const totalShares = 10n * SHARE_COEF;
		const totalAlpha = 10_000_000_000n; // 10 α
		// User has 2.5 shares out of 10 → 25% → 2.5 α = 2_500_000_000 rao
		expect(computeBalance((25n * SHARE_COEF) / 10n, totalShares, totalAlpha)).toBe(2_500_000_000n);
	});
});

describe("computePoolApyPct", () => {
	it("returns null when start pool has no shares", () => {
		expect(computePoolApyPct(1_000_000n, 0n, 2_000_000n, 1n * SHARE_COEF, 30)).toBeNull();
	});

	it("returns null when days <= 0", () => {
		expect(
			computePoolApyPct(1_000_000n, 1n * SHARE_COEF, 2_000_000n, 1n * SHARE_COEF, 0),
		).toBeNull();
	});

	it("returns ~0% when PSV is flat", () => {
		const apy = computePoolApyPct(
			1_000_000_000n,
			1n * SHARE_COEF,
			1_000_000_000n,
			1n * SHARE_COEF,
			30,
		);
		expect(apy).not.toBeNull();
		expect(Math.abs(apy!)).toBeLessThan(0.001);
	});

	it("returns positive APY when PSV grew", () => {
		// PSV grew from 1e9 to 1.1e9 over 30 days = 10% in 30d → ~214% annualized
		const apy = computePoolApyPct(
			1_000_000_000n,
			1n * SHARE_COEF,
			1_100_000_000n,
			1n * SHARE_COEF,
			30,
		);
		expect(apy).not.toBeNull();
		expect(apy!).toBeGreaterThan(200);
		expect(apy!).toBeLessThan(230);
	});

	it("returns negative APY when PSV dropped", () => {
		const apy = computePoolApyPct(
			1_000_000_000n,
			1n * SHARE_COEF,
			900_000_000n,
			1n * SHARE_COEF,
			30,
		);
		expect(apy).not.toBeNull();
		expect(apy!).toBeLessThan(0);
	});

	it("returns -100 when pool fully drained", () => {
		const apy = computePoolApyPct(1_000_000_000n, 1n * SHARE_COEF, 0n, 1n * SHARE_COEF, 30);
		expect(apy).toBe(-100);
	});
});

describe("computePassiveDividend", () => {
	it("is 0 when user had no starting shares", () => {
		const d = computePassiveDividend(
			0n,
			1_000_000_000n,
			1n * SHARE_COEF,
			1_100_000_000n,
			1n * SHARE_COEF,
		);
		expect(d).toBe(0n);
	});

	it("is 0 when PSV did not change (shares and alpha scaled together)", () => {
		const d = computePassiveDividend(
			1n * SHARE_COEF,
			1_000_000_000n,
			2n * SHARE_COEF,
			// Pool grew in shares AND alpha proportionally — PSV unchanged.
			2_000_000_000n,
			4n * SHARE_COEF,
		);
		expect(d).toBe(0n);
	});

	it("credits startShares with the full PSV growth", () => {
		// start: totalAlpha=1e9, totalShares=1e18 → PSV = 1 rao/share-bit
		// end:   totalAlpha=2e9, totalShares=1e18 → PSV = 2 rao/share-bit
		// user had 0.5 × SHARE_COEF shares → gained 0.5 × (2-1) × 1e9 / 1e18 = 0.5 rao? no
		// Actually: startAlpha × (totalAlphaEnd × totalSharesStart − totalAlphaStart × totalSharesEnd) / (start × end)
		// = (0.5e18) × (2e9 × 1e18 − 1e9 × 1e18) / (1e18 × 1e18)
		// = (0.5e18) × (1e9 × 1e18) / (1e36)
		// = 0.5e18 × 1e27 / 1e36 = 0.5e9 = 500_000_000 rao = 0.5 α
		const d = computePassiveDividend(
			SHARE_COEF / 2n,
			1_000_000_000n,
			SHARE_COEF,
			2_000_000_000n,
			SHARE_COEF,
		);
		expect(d).toBe(500_000_000n);
	});

	it("is negative when pool shrank (PSV decreased)", () => {
		const d = computePassiveDividend(
			SHARE_COEF,
			1_000_000_000n,
			SHARE_COEF,
			500_000_000n,
			SHARE_COEF,
		);
		expect(d).toBeLessThan(0n);
	});
});

describe("computeRealizedDividend", () => {
	it("equals passive when user shares held constant", () => {
		const samples: SampleForMath[] = [
			{ alpha: SHARE_COEF, ...pool(SHARE_COEF, 1_000_000_000n) },
			{ alpha: SHARE_COEF, ...pool(SHARE_COEF, 1_100_000_000n) },
			{ alpha: SHARE_COEF, ...pool(SHARE_COEF, 1_200_000_000n) },
		];
		const realized = computeRealizedDividend(samples);
		const passive = computePassiveDividend(
			samples[0].alpha,
			samples[0].totalAlpha,
			samples[0].totalShares,
			samples[samples.length - 1].totalAlpha,
			samples[samples.length - 1].totalShares,
		);
		expect(realized).toBe(passive);
		// Also sanity: it should equal 200_000_000 rao for 1 share catching +0.2 PSV
		expect(realized).toBe(200_000_000n);
	});

	it("is less than passive when user unstaked mid-period", () => {
		// User held 1 share for the first step, then dropped to 0.5 shares for the second step.
		// Passive (theoretical, using startShares=1) would credit 1×ΔPSV_total.
		// Realized should credit 1×ΔPSV_step1 + 0.5×ΔPSV_step2.
		const samples: SampleForMath[] = [
			{ alpha: SHARE_COEF, ...pool(SHARE_COEF, 1_000_000_000n) },
			{ alpha: SHARE_COEF / 2n, ...pool(SHARE_COEF / 2n, 550_000_000n) }, // withdrew 0.5 at PSV=1.1
			{ alpha: SHARE_COEF / 2n, ...pool(SHARE_COEF / 2n, 600_000_000n) },
		];
		const realized = computeRealizedDividend(samples);
		const passive = computePassiveDividend(
			samples[0].alpha,
			samples[0].totalAlpha,
			samples[0].totalShares,
			samples[samples.length - 1].totalAlpha,
			samples[samples.length - 1].totalShares,
		);
		expect(realized).toBeGreaterThan(0n);
		expect(realized).toBeLessThan(passive);
	});

	it("credits new shares for periods where they existed", () => {
		// User deposits mid-period. min(prev,cur) = prev_shares for the growth step,
		// so only original shares get credited for that interval.
		const samples: SampleForMath[] = [
			{ alpha: SHARE_COEF, ...pool(SHARE_COEF, 1_000_000_000n) },
			// User added 1 more share at PSV=1.1 (pool grew proportionally: +1 share, +1.1 α)
			{ alpha: 2n * SHARE_COEF, ...pool(2n * SHARE_COEF, 2_100_000_000n) },
			// PSV continues to grow to 1.2
			{ alpha: 2n * SHARE_COEF, ...pool(2n * SHARE_COEF, 2_400_000_000n) },
		];
		const realized = computeRealizedDividend(samples);
		// Step 1: min(1,2) = 1 share × (PSV 1.0 → 1.05, since totalAlpha/totalShares = 2.1/2 = 1.05). Wait — actually
		// the deposit at PSV 1.1 shouldn't change PSV, so step1's psv is 1 → 1.05? Let me recompute.
		// Sample 0: PSV = 1e9/1e18 = 1e-9
		// Sample 1: PSV = 2.1e9/2e18 = 1.05e-9 (pool grew a bit, not proportional here)
		// step1 dividend credited to 1 share (min) × (1.05e-9 - 1e-9) × 1e18 = 1e18 × 0.05e-9 = 5e7 rao = 0.05 α
		// Sample 2: PSV = 2.4e9/2e18 = 1.2e-9
		// step2 dividend credited to 2 shares × (1.2e-9 - 1.05e-9) × 1 = 2 × 0.15e9 = 3e8 rao = 0.3 α
		// total = 0.35 α = 350_000_000 rao
		expect(realized).toBe(350_000_000n);
	});

	it("returns 0 for empty or single-sample arrays", () => {
		expect(computeRealizedDividend([])).toBe(0n);
		expect(
			computeRealizedDividend([{ alpha: SHARE_COEF, ...pool(SHARE_COEF, 1_000_000_000n) }]),
		).toBe(0n);
	});

	it("skips intervals where user has 0 shares at both endpoints", () => {
		const samples: SampleForMath[] = [
			{ alpha: 0n, ...pool(SHARE_COEF, 1_000_000_000n) },
			{ alpha: 0n, ...pool(SHARE_COEF, 1_100_000_000n) },
			{ alpha: SHARE_COEF, ...pool(2n * SHARE_COEF, 2_300_000_000n) }, // deposit here
		];
		const realized = computeRealizedDividend(samples);
		// Step 1: min(0,0)=0 → skip. Step 2: min(0, SHARE_COEF)=0 → skip.
		expect(realized).toBe(0n);
	});
});
