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
