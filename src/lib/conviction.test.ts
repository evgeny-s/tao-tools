import { describe, expect, it } from "vitest";
import {
	type LockContext,
	type LockState,
	expDecay,
	projectForward,
	rollForward,
	simulateUnlockAt,
	simulateUnlockAtHead,
} from "./conviction";

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

describe("simulateUnlockAtHead", () => {
	const TOTAL_ALPHA = 2_000_000_000_000n; // 2000 α
	function ctxWith(lock: LockState | null, headBlock = 2 * TAU_MATURITY): LockContext {
		return {
			tauMaturity: TAU_MATURITY,
			tauUnlock: TAU_UNLOCK,
			blockTimeMs: 12_000,
			headBlock,
			lock,
			totalAlphaOnSubnetRao: TOTAL_ALPHA,
		};
	}

	it("returns the input ctx unchanged when there is no lock", () => {
		const ctx = ctxWith(null);
		expect(simulateUnlockAtHead(ctx, 100_000_000_000n)).toBe(ctx);
	});

	it("returns the input ctx unchanged when amount is zero", () => {
		const lock = lockOf({ lockedRao: ONE_THOUSAND_ALPHA_RAO, lastUpdate: 0 });
		const ctx = ctxWith(lock);
		expect(simulateUnlockAtHead(ctx, 0n)).toBe(ctx);
	});

	it("throws when amount exceeds rolled-forward locked_mass", () => {
		const lock = lockOf({ lockedRao: ONE_THOUSAND_ALPHA_RAO, lastUpdate: 0 });
		const ctx = ctxWith(lock);
		expect(() => simulateUnlockAtHead(ctx, ONE_THOUSAND_ALPHA_RAO + 1n)).toThrow(/exceeds/);
	});

	it("moves amount from locked_mass to unlocked_mass and sets lastUpdate to head", () => {
		// Head is at 2τ_maturity — conviction has matured to ~86.5% of 1000 α
		// before the unlock. Unlocking 200 should drop locked to 800, push
		// unlocked to 200, decrement conviction by 200 (saturating), and stamp
		// lastUpdate = head.
		const lock = lockOf({ lockedRao: ONE_THOUSAND_ALPHA_RAO, lastUpdate: 0 });
		const ctx = ctxWith(lock);
		const sim = simulateUnlockAtHead(ctx, 200_000_000_000n);
		expect(sim.lock).not.toBeNull();
		expect(sim.lock!.lockedMass).toBe(800_000_000_000n);
		expect(sim.lock!.unlockedMass).toBe(200_000_000_000n);
		expect(sim.lock!.lastUpdate).toBe(ctx.headBlock);
		// conviction at 2τ ≈ 1000·(1−e^-2) ≈ 864.66 α; after -200 ≈ 664.66 α
		const convAlpha = Number(sim.lock!.convictionBits) / Math.pow(2, 64) / 1e9;
		expect(convAlpha).toBeCloseTo(1000 * (1 - 1 / (Math.E * Math.E)) - 200, 3);
	});

	it("saturates conviction at 0 when amount > rolled conviction", () => {
		// Brand-new lock (head=lastUpdate=0) — conviction is 0; unlocking any
		// amount must not produce negative conviction.
		const lock = lockOf({ lockedRao: ONE_THOUSAND_ALPHA_RAO, lastUpdate: 0 });
		const ctx = ctxWith(lock, 0);
		const sim = simulateUnlockAtHead(ctx, 200_000_000_000n);
		expect(sim.lock!.convictionBits).toBe(0n);
	});

	it("simulateUnlockAt rolls forward to the event block, not head", () => {
		// Head at lastUpdate=0; simulate unlock at 1τ_maturity later. Without
		// roll-forward the conviction would still be 0 and saturating_sub
		// would mask the loss; with roll-forward, conviction at 1τ is ~63.2%
		// of 1000 ≈ 632 α and after -200 should be ~432 α.
		const lock = lockOf({ lockedRao: ONE_THOUSAND_ALPHA_RAO, lastUpdate: 0 });
		const ctx = ctxWith(lock, 0);
		const sim = simulateUnlockAt(ctx, 200_000_000_000n, TAU_MATURITY);
		expect(sim.lock!.lastUpdate).toBe(TAU_MATURITY);
		const convAlpha = Number(sim.lock!.convictionBits) / Math.pow(2, 64) / 1e9;
		expect(convAlpha).toBeCloseTo(1000 * (1 - 1 / Math.E) - 200, 3);
	});

	it("simulateUnlockAt clamps a past atBlock to head", () => {
		const lock = lockOf({ lockedRao: ONE_THOUSAND_ALPHA_RAO, lastUpdate: 0 });
		const ctx = ctxWith(lock, 100); // head = block 100
		const sim = simulateUnlockAt(ctx, 100_000_000_000n, 50); // before head
		expect(sim.lock!.lastUpdate).toBe(100); // clamped up
	});
});

describe("projectForward with mid-window unlock event", () => {
	function ctxWith(lock: LockState | null, headBlock = 0): LockContext {
		return {
			tauMaturity: TAU_MATURITY,
			tauUnlock: TAU_UNLOCK,
			blockTimeMs: 12_000,
			headBlock,
			lock,
			totalAlphaOnSubnetRao: 2_000_000_000_000n,
		};
	}

	it("emits a step at the event block: locked drops, unlocked jumps", () => {
		const lock = lockOf({ lockedRao: ONE_THOUSAND_ALPHA_RAO, lastUpdate: 0 });
		const ctx = ctxWith(lock, 0);
		// Project 180 days at 1 sample/day; unlock 200 α on day 90 (1τ_maturity).
		const samples = projectForward(ctx, 180, 1, {
			atBlock: TAU_MATURITY,
			amountRao: 200_000_000_000n,
		});
		// Locate the back-to-back pair at the event block.
		const evBlock = TAU_MATURITY;
		let stepIdx = -1;
		for (let i = 1; i < samples.length; i++) {
			if (samples[i - 1].block === evBlock && samples[i].block === evBlock) {
				stepIdx = i;
				break;
			}
		}
		expect(stepIdx).toBeGreaterThan(0);
		// Pre sample: still 1000 α locked, 0 unlocked.
		expect(samples[stepIdx - 1].locked).toBeCloseTo(1000, 3);
		expect(samples[stepIdx - 1].unlocked).toBeCloseTo(0, 3);
		// Post sample: 800 α locked, 200 unlocked.
		expect(samples[stepIdx].locked).toBeCloseTo(800, 3);
		expect(samples[stepIdx].unlocked).toBeCloseTo(200, 3);
	});

	it("samples before the event use the original lock", () => {
		const lock = lockOf({ lockedRao: ONE_THOUSAND_ALPHA_RAO, lastUpdate: 0 });
		const ctx = ctxWith(lock, 0);
		const samples = projectForward(ctx, 180, 1, {
			atBlock: TAU_MATURITY,
			amountRao: 200_000_000_000n,
		});
		// First sample is at head (block 0) — pre-unlock locked is 1000 α.
		expect(samples[0].locked).toBeCloseTo(1000, 3);
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
