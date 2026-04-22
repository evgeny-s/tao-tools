// Shared constants + pure helpers. Extracted from fetcher.ts for testability.

// Subtensor share pool uses SafeFloat-style "bits" scaled by 1e18.
export const SHARE_COEF = 1_000_000_000_000_000_000n;
// TAO / alpha token use 9 decimals (1 α = 1e9 rao).
export const TAO_BASE = 1_000_000_000n;
// u64::MAX — used as "1.0" scale for child-key proportions.
export const U64_MAX_N = 18_446_744_073_709_551_615n;

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

// Parses a user-entered block number; throws with a readable message on garbage input.
export function parseBlockNumber(value: string): number {
	const n = Number(value);
	if (!Number.isFinite(n) || n < 1 || Math.floor(n) !== n) {
		throw new Error(`Invalid block number: "${value}"`);
	}
	return n;
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
