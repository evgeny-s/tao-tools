import { describe, expect, it } from "vitest";
import { type LockState, expDecay, rollForward } from "./conviction";

// τ values from subtensor (DefaultMaturityRate / DefaultUnlockRate):
//   τ_maturity = 7200 × 90 = 648_000 blocks (~90d @ 12s)
//   τ_unlock   = 7200 × 30 = 216_000 blocks (~30d @ 12s)
const TAU_MATURITY = 648_000;
const TAU_UNLOCK = 216_000;
const BLOCKS_PER_DAY = 7200;

// 1000 α in rao (1e9 rao per α).
const ONE_THOUSAND_ALPHA_RAO = 1_000_000_000_000n;
// U64F64 scale.
const TWO_64 = 1n << 64n;

function lockOf(opts: {
	lockedRao: bigint;
	unlockedRao?: bigint;
	convictionAlpha?: number; // for readability — converted to U64F64 internally
	lastUpdate?: number;
}): LockState {
	const convictionRao = (opts.convictionAlpha ?? 0) * 1e9;
	return {
		lockedMass: opts.lockedRao,
		unlockedMass: opts.unlockedRao ?? 0n,
		convictionBits: BigInt(Math.floor(convictionRao)) * TWO_64,
		lastUpdate: opts.lastUpdate ?? 0,
		hotkey: "5DummyHotkey",
	};
}

describe("expDecay", () => {
	it("returns 1 when dt is 0", () => {
		expect(expDecay(0, 100)).toBe(1);
		expect(expDecay(0, 0)).toBe(1);
	});

	it("returns 0 when tau is 0 and dt > 0", () => {
		expect(expDecay(10, 0)).toBe(0);
	});

	it("returns ~1/e (≈0.3679) at dt = τ", () => {
		expect(expDecay(100, 100)).toBeCloseTo(1 / Math.E, 6);
	});

	it("returns ~1/e^2 at dt = 2τ", () => {
		expect(expDecay(200, 100)).toBeCloseTo(1 / (Math.E * Math.E), 6);
	});

	it("clamps to exp(-40) for very large dt/τ", () => {
		// 100τ → would underflow to truly 0 in float anyway, but the runtime
		// clamps at -40 so we mirror that to keep numbers identical to-chain.
		const v = expDecay(100 * TAU_UNLOCK, TAU_UNLOCK);
		expect(v).toBe(Math.exp(-40));
	});
});

describe("rollForward — conviction maturity", () => {
	it("conviction = 0 at lastUpdate (no time elapsed)", () => {
		const lock = lockOf({ lockedRao: ONE_THOUSAND_ALPHA_RAO, lastUpdate: 1_000 });
		const { convictionRao } = rollForward(lock, 1_000, TAU_MATURITY, TAU_UNLOCK);
		expect(convictionRao).toBe(0);
	});

	it("conviction ≈ 63.2% of locked at 1τ_maturity (~90 days)", () => {
		const lock = lockOf({ lockedRao: ONE_THOUSAND_ALPHA_RAO, lastUpdate: 0 });
		const at1tau = TAU_MATURITY; // = 90 days in blocks
		const { convictionRao } = rollForward(lock, at1tau, TAU_MATURITY, TAU_UNLOCK);
		const fraction = convictionRao / Number(ONE_THOUSAND_ALPHA_RAO);
		expect(fraction).toBeCloseTo(1 - 1 / Math.E, 6); // 0.6321...
	});

	it("conviction ≈ 86.5% at 2τ, ≈ 95% at 3τ", () => {
		const lock = lockOf({ lockedRao: ONE_THOUSAND_ALPHA_RAO, lastUpdate: 0 });
		const at2 = rollForward(lock, 2 * TAU_MATURITY, TAU_MATURITY, TAU_UNLOCK).convictionRao;
		const at3 = rollForward(lock, 3 * TAU_MATURITY, TAU_MATURITY, TAU_UNLOCK).convictionRao;
		expect(at2 / Number(ONE_THOUSAND_ALPHA_RAO)).toBeCloseTo(1 - 1 / (Math.E * Math.E), 6);
		expect(at3 / Number(ONE_THOUSAND_ALPHA_RAO)).toBeCloseTo(1 - 1 / (Math.E * Math.E * Math.E), 6);
	});

	it("conviction approaches locked at 5τ (>99%, still strictly below)", () => {
		// f64 can't represent the gap at 40τ+ when m=1e12 — runtime hits the
		// dt/τ=-40 clamp around there too. 5τ stays well within precision and
		// is enough to show the asymptotic shape.
		const lock = lockOf({ lockedRao: ONE_THOUSAND_ALPHA_RAO, lastUpdate: 0 });
		const far = rollForward(lock, 5 * TAU_MATURITY, TAU_MATURITY, TAU_UNLOCK).convictionRao;
		expect(far).toBeLessThan(Number(ONE_THOUSAND_ALPHA_RAO));
		expect(far).toBeGreaterThan(Number(ONE_THOUSAND_ALPHA_RAO) * 0.99);
	});

	it("starting from non-zero conviction matures from there toward locked", () => {
		// User had c0 = 300 α stored from a previous roll-forward. After τ
		// blocks, conviction = m − (m − c0)·(1/e) = 1000 − 700/e ≈ 742.5 α.
		const lock = lockOf({
			lockedRao: ONE_THOUSAND_ALPHA_RAO,
			convictionAlpha: 300,
			lastUpdate: 0,
		});
		const { convictionRao } = rollForward(lock, TAU_MATURITY, TAU_MATURITY, TAU_UNLOCK);
		const expectedAlpha = 1000 - 700 / Math.E;
		expect(convictionRao / 1e9).toBeCloseTo(expectedAlpha, 3);
	});
});

describe("rollForward — unlocked mass decay", () => {
	it("unlocked_mass = stored at lastUpdate", () => {
		const lock = lockOf({
			lockedRao: 0n,
			unlockedRao: ONE_THOUSAND_ALPHA_RAO,
			lastUpdate: 500,
		});
		const { unlockedRao } = rollForward(lock, 500, TAU_MATURITY, TAU_UNLOCK);
		expect(unlockedRao).toBe(ONE_THOUSAND_ALPHA_RAO);
	});

	it("unlocked_mass ≈ 36.8% at 1τ_unlock (~30 days)", () => {
		const lock = lockOf({
			lockedRao: 0n,
			unlockedRao: ONE_THOUSAND_ALPHA_RAO,
			lastUpdate: 0,
		});
		const { unlockedRao } = rollForward(lock, TAU_UNLOCK, TAU_MATURITY, TAU_UNLOCK);
		const fraction = Number(unlockedRao) / Number(ONE_THOUSAND_ALPHA_RAO);
		expect(fraction).toBeCloseTo(1 / Math.E, 4);
	});

	it("unlocked_mass ≈ 5% at 3τ_unlock", () => {
		const lock = lockOf({
			lockedRao: 0n,
			unlockedRao: ONE_THOUSAND_ALPHA_RAO,
			lastUpdate: 0,
		});
		const { unlockedRao } = rollForward(lock, 3 * TAU_UNLOCK, TAU_MATURITY, TAU_UNLOCK);
		const fraction = Number(unlockedRao) / Number(ONE_THOUSAND_ALPHA_RAO);
		expect(fraction).toBeCloseTo(1 / Math.pow(Math.E, 3), 4);
	});

	it("unlocked_mass decays toward zero asymptotically (not exactly)", () => {
		const lock = lockOf({
			lockedRao: 0n,
			unlockedRao: ONE_THOUSAND_ALPHA_RAO,
			lastUpdate: 0,
		});
		// 10τ ≈ 99.995% gone — still strictly positive in the runtime's math.
		const { unlockedRao } = rollForward(lock, 10 * TAU_UNLOCK, TAU_MATURITY, TAU_UNLOCK);
		expect(unlockedRao).toBeGreaterThanOrEqual(0n);
		expect(unlockedRao).toBeLessThan(ONE_THOUSAND_ALPHA_RAO / 1000n);
	});
});

describe("rollForward — locked mass is invariant", () => {
	it("locked_mass does not decay (only user actions can change it)", () => {
		const lock = lockOf({ lockedRao: ONE_THOUSAND_ALPHA_RAO, lastUpdate: 0 });
		const farFuture = rollForward(lock, 10 * BLOCKS_PER_DAY * 365, TAU_MATURITY, TAU_UNLOCK);
		expect(farFuture.lockedRao).toBe(ONE_THOUSAND_ALPHA_RAO);
	});
});

describe("rollForward — `now` before lastUpdate", () => {
	// Defensive: if a caller passes a `now` earlier than the stored
	// lastUpdate (shouldn't happen normally, but guard against off-by-one in
	// history mode where we read state AT block N and lastUpdate == N), the
	// runtime's `roll_forward_lock` short-circuits and returns the snapshot
	// unchanged. We do the same.
	it("returns stored values unchanged", () => {
		const lock = lockOf({
			lockedRao: ONE_THOUSAND_ALPHA_RAO,
			unlockedRao: 500_000_000_000n,
			convictionAlpha: 700,
			lastUpdate: 1_000,
		});
		const { lockedRao, unlockedRao, convictionRao } = rollForward(
			lock,
			500,
			TAU_MATURITY,
			TAU_UNLOCK,
		);
		expect(lockedRao).toBe(ONE_THOUSAND_ALPHA_RAO);
		expect(unlockedRao).toBe(500_000_000_000n);
		// 700 α exactly, allowing tiny U64F64 round-trip drift.
		expect(convictionRao / 1e9).toBeCloseTo(700, 6);
	});
});
