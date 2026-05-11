// Shared constants + pure helpers. Extracted from fetcher.ts for testability.

// Internal precision constant used in bigint share-balance math; chosen to be
// large enough that `(alpha * SHARE_COEF) / totalShares` keeps useful digits.
export const SHARE_COEF = 1_000_000_000_000_000_000n;
// TAO / alpha token use 9 decimals (1 α = 1e9 rao).
export const TAO_BASE = 1_000_000_000n;
// u64::MAX — used as "1.0" scale for child-key proportions.
export const U64_MAX_N = 18_446_744_073_709_551_615n;
// Substrate block time for the subtensor chain. Used to convert wall-clock
// durations to block counts; kept in one place so the two fetchers can't drift.
export const BLOCK_TIME_S = 12;
export const BLOCKS_PER_DAY = (24 * 60 * 60) / BLOCK_TIME_S;
// Legacy Alpha / TotalHotkeyShares stored substrate-fixed U64F64 values, where
// `bits` is the integer encoding and real_value = bits / 2^64. We keep every
// share-quantity bigint in this "× 2^64" representation so existing math
// (which relies on alpha and totalShares cancelling units) needs no changes —
// V2 (SafeFloat) values are scaled into the same representation on read.
const TWO_64 = 1n << 64n;

export function formatTao(v: bigint, precision = 6): string {
	const neg = v < 0n;
	const abs = neg ? -v : v;
	const i = abs / TAO_BASE;
	const f = abs % TAO_BASE;
	return `${neg ? "-" : ""}${i}.${f.toString().padStart(9, "0").slice(0, precision)}`;
}

// Runs `fn` over `items` with at most `limit` concurrent executions.
// Preserves index-order in the result array.
export async function withLimit<T, R>(
	items: T[],
	limit: number,
	fn: (x: T, i: number) => Promise<R>,
	onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let idx = 0;
	let done = 0;
	const workers = Array.from(
		{ length: Math.min(Math.max(limit, 1), items.length || 1) },
		async () => {
			while (true) {
				const cur = idx++;
				if (cur >= items.length) return;
				results[cur] = await fn(items[cur], cur);
				done++;
				onProgress?.(done, items.length);
			}
		},
	);
	await Promise.all(workers);
	return results;
}

// Rough SS58 sanity — enough to surface typos client-side before they reach @polkadot.
// Substrate SS58 addresses are base58 (alphabet below) and land at 47–48 chars for Bittensor.
const SS58_ALPHABET = /^[1-9A-HJ-NP-Za-km-z]+$/;
export function isLikelySs58(s: string): boolean {
	const trimmed = s.trim();
	if (trimmed.length < 46 || trimmed.length > 50) return false;
	return SS58_ALPHABET.test(trimmed);
}

export function isValidWsUrl(s: string): boolean {
	return /^wss?:\/\/[^\s]+$/i.test(s.trim());
}

// HTML5 `<input type="date">` and `<input type="datetime-local">` round-trip
// in *local* time. `Date.toISOString()` returns UTC, so naively slicing it
// loses the user's timezone offset — on UTC+N the round trip silently shifts
// "now" N hours into the past, which on short test chains can clamp the
// resolved block range below the head and produce empty windows.
function toLocalIso(d: Date): string {
	const tz = d.getTimezoneOffset() * 60_000;
	return new Date(d.getTime() - tz).toISOString();
}

export function localDateTimeInput(d: Date): string {
	return toLocalIso(d).slice(0, 16); // yyyy-MM-ddTHH:mm
}

export function localDateInput(d: Date): string {
	return toLocalIso(d).slice(0, 10); // yyyy-MM-dd
}

// Parses a user-entered block number; throws with a readable message on garbage input.
export function parseBlockNumber(value: string): number {
	const n = Number(value);
	if (!Number.isFinite(n) || n < 1 || Math.floor(n) !== n) {
		throw new Error(`Invalid block number: "${value}"`);
	}
	return n;
}

// Subtensor PR #2353 introduced AlphaV2 / TotalHotkeySharesV2 storing SafeFloat
// (mantissa × 10^exponent) values, with a *lazy*, *unsynced* per-key migration
// from the legacy U64F64 maps. Clients reading the storage directly must check
// both versions and use whichever holds a non-zero value. We normalize V2 into
// the same "× 2^64" representation as V1 so downstream math is version-blind.
//
// Returns 0n if `safeFloat` is missing/malformed (e.g. V2 storage absent on a
// pre-upgrade block's metadata).
export function safeFloatToScaledBits(safeFloat: any): bigint {
	if (!safeFloat) return 0n;
	try {
		const mantissa = BigInt(safeFloat.mantissa.toString());
		if (mantissa === 0n) return 0n;
		const exponent = Number(safeFloat.exponent.toString());
		const scaled = mantissa * TWO_64;
		if (exponent >= 0) return scaled * 10n ** BigInt(exponent);
		return scaled / 10n ** BigInt(-exponent);
	} catch {
		return 0n;
	}
}

function legacySharesToScaledBits(legacy: any): bigint {
	if (!legacy) return 0n;
	try {
		return legacy.bits.toBigInt() as bigint;
	} catch {
		return 0n;
	}
}

// Reads a share-quantity from both legacy (U64F64) and V2 (SafeFloat) storage
// query results, preferring the V2 value when it is non-zero. Matches the
// runtime-side merge semantics in `Pallet::alpha_iter_prefix` (PR #2353).
export function mergeShares(legacyV1: any, safeFloatV2: any): bigint {
	const v2 = safeFloatToScaledBits(safeFloatV2);
	if (v2 !== 0n) return v2;
	return legacySharesToScaledBits(legacyV1);
}

export function decodeIdentity(raw: any): any {
	if (!raw || raw.isNone) return null;
	const u = raw.isSome ? raw.unwrap() : raw;
	const obj: any = {};
	for (const f of ["name", "url", "githubRepo", "image", "discord", "description"]) {
		try {
			const val = u[f];
			if (val !== undefined) {
				const s = val.toHuman ? val.toHuman() : val.toString();
				if (s) obj[f] = s;
			}
		} catch {}
	}
	return Object.keys(obj).length ? obj : null;
}
