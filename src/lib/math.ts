// Pure dividend / balance math — exposed separately for unit testing.
// All bigint math; no side effects.

import { SHARE_COEF } from "./utils";

export type SampleForMath = {
	alpha: bigint; // user shares (SafeFloat bits)
	totalAlpha: bigint; // pool alpha (rao)
	totalShares: bigint; // pool shares (SafeFloat bits)
};

// User's balance in rao = user_shares × (totalAlpha / totalShares).
// Two-step division preserves precision for big pools.
export function computeBalance(alpha: bigint, totalShares: bigint, totalAlpha: bigint): bigint {
	if (totalShares === 0n) return 0n;
	return (((alpha * SHARE_COEF) / totalShares) * totalAlpha) / SHARE_COEF;
}

// Pool APY from PSV growth, annualized.
// Returns null if start PSV is undefined; -100 if pool was fully drained.
export function computePoolApyPct(
	startTotalAlpha: bigint,
	startTotalShares: bigint,
	endTotalAlpha: bigint,
	endTotalShares: bigint,
	days: number,
): number | null {
	if (startTotalShares === 0n || days <= 0) return null;
	const psvStart = (Number(startTotalAlpha) * 1e18) / Number(startTotalShares);
	const psvEnd = endTotalShares > 0n ? (Number(endTotalAlpha) * 1e18) / Number(endTotalShares) : 0;
	if (psvStart === 0) return null;
	const psvRatio = psvEnd / psvStart - 1;
	if (1 + psvRatio <= 0) return -100;
	return (Math.pow(1 + psvRatio, 365 / days) - 1) * 100;
}

// Passive dividend = theoretical "if user held startShares constant for whole period".
// Formula: startAlpha × (totalAlphaEnd/totalSharesEnd − totalAlphaStart/totalSharesStart)
// Rearranged for bigint integer math:
//   startAlpha × (totalAlphaEnd × totalSharesStart − totalAlphaStart × totalSharesEnd)
//               ÷ (totalSharesStart × totalSharesEnd)
export function computePassiveDividend(
	firstAlpha: bigint,
	firstTotalAlpha: bigint,
	firstTotalShares: bigint,
	lastTotalAlpha: bigint,
	lastTotalShares: bigint,
): bigint {
	if (firstAlpha === 0n || firstTotalShares === 0n || lastTotalShares === 0n) return 0n;
	const num = firstAlpha * (lastTotalAlpha * firstTotalShares - firstTotalAlpha * lastTotalShares);
	const den = firstTotalShares * lastTotalShares;
	return den > 0n ? num / den : 0n;
}

// Realized dividend = time-weighted Σ min(shares[i-1], shares[i]) × ΔPSV[i].
// Only credits dividend to shares the user CONTINUOUSLY held through each interval —
// correctly handles mid-period stakes and unstakes.
export function computeRealizedDividend(samples: SampleForMath[]): bigint {
	let total = 0n;
	for (let d = 1; d < samples.length; d++) {
		const a = samples[d - 1];
		const b = samples[d];
		if (a.totalShares === 0n || b.totalShares === 0n) continue;
		const minShares = a.alpha < b.alpha ? a.alpha : b.alpha;
		if (minShares === 0n) continue;
		const num = minShares * (b.totalAlpha * a.totalShares - a.totalAlpha * b.totalShares);
		const den = a.totalShares * b.totalShares;
		if (den > 0n) total += num / den;
	}
	return total;
}
