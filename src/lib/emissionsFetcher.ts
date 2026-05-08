// Scans a block range for `subtensorModule.IncentiveAlphaEmittedToMiners` events
// and aggregates per-subnet, per-miner alpha emissions.
//
// Event signature (pallets/subtensor/src/macros/events.rs):
//   IncentiveAlphaEmittedToMiners {
//     netuid: NetUidStorageIndex,
//     emissions: Vec<AlphaBalance>,   // index = UID, value = u64 raw alpha
//   }
//
// The event fires once per epoch per subnet (tempo, typically 360 blocks). To
// avoid missing any, we walk every block in the window and pull `system.events`.

import { ApiPromise, WsProvider } from "@polkadot/api";
import { withLimit } from "./utils";
import type { FetchBound, StatusUpdate } from "./fetcher";

export const DEFAULT_RPC = "wss://subtensor-archive.app.minesight.co.uk";

export type EmissionsParams = {
	rpc: string;
	netuidFilter: number | null; // null = all subnets
	from: FetchBound;
	to: FetchBound;
	concurrency: number;
};

export type MinerSlice = {
	uid: number;
	hotkey: string;
	alpha: bigint;
};

export type EmissionEvent = {
	block: number;
	netuid: number;
	timestampMs: number;
	totalAlpha: bigint;
	perMiner: MinerSlice[]; // sorted by alpha desc, only non-zero
};

export type MinerTotal = {
	uid: number;
	hotkey: string;
	total: bigint;
	count: number; // how many events they appeared in (non-zero share)
};

export type NetuidData = {
	netuid: number;
	events: EmissionEvent[];
	miners: MinerTotal[]; // sorted by total desc
	totalAlpha: bigint;
};

export type EmissionsResult = {
	meta: {
		rpc: string;
		startBlock: number;
		endBlock: number;
		blocksScanned: number;
		startMs: number;
		endMs: number;
	};
	netuids: NetuidData[];
	totalEvents: number;
	totalAlpha: bigint;
};

const BLOCK_TIME_S = 12;
const TAO_BASE = 1_000_000_000n;

function alphaToNumber(v: bigint): number {
	return Number(v) / Number(TAO_BASE);
}

// Decode `Vec<AlphaBalance>` from event data. polkadot.js's `data.toJSON()` returns
// an array of u64 values (numbers or hex strings depending on size). AlphaBalance
// is a `pub struct AlphaBalance(u64)` newtype, so it serializes as its inner u64.
function decodeEmissionsVec(raw: any): bigint[] {
	if (!Array.isArray(raw)) return [];
	return raw.map((v) => {
		if (typeof v === "bigint") return v;
		if (typeof v === "number") return BigInt(v);
		if (typeof v === "string") return BigInt(v);
		// Some codecs wrap in { bits } or similar — fall back gracefully.
		try {
			return BigInt((v as any)?.toString?.() ?? 0);
		} catch {
			return 0n;
		}
	});
}

export async function fetchEmissionEvents(
	params: EmissionsParams,
	onStatus: (s: StatusUpdate) => void,
): Promise<EmissionsResult> {
	const { rpc, netuidFilter, from, to, concurrency } = params;

	onStatus({ kind: "info", message: `Connecting to ${rpc}...` });
	const api = await ApiPromise.create({ provider: new WsProvider(rpc) });
	try {
		const head = await api.rpc.chain.getHeader();
		const headBlock = head.number.toNumber();
		const nowMs = Date.now();

		const toBlockFromDate = (d: Date) => {
			const diffBlocks = Math.floor((nowMs - d.getTime()) / 1000 / BLOCK_TIME_S);
			return Math.max(1, headBlock - diffBlocks);
		};
		const startBlock = typeof from === "number" ? from : toBlockFromDate(from);
		const endBlock = typeof to === "number" ? to : toBlockFromDate(to);
		if (startBlock >= endBlock) {
			throw new Error(`Invalid range: start ${startBlock} ≥ end ${endBlock}`);
		}
		const blockToMs = (b: number) => nowMs - (headBlock - b) * BLOCK_TIME_S * 1000;

		const blocksScanned = endBlock - startBlock + 1;
		onStatus({
			kind: "info",
			message: `Window: block ${startBlock} → ${endBlock} (${blocksScanned} blocks)`,
		});

		// Walk every block. For each: hash → apiAt → events.
		const blockNumbers: number[] = [];
		for (let b = startBlock; b <= endBlock; b++) blockNumbers.push(b);

		const rawEvents: { block: number; netuid: number; emissions: bigint[] }[] = [];
		await withLimit(
			blockNumbers,
			concurrency,
			async (bn) => {
				const hash = (await api.rpc.chain.getBlockHash(bn)).toHex();
				const apiAt = await api.at(hash);
				const events: any = await apiAt.query.system.events();
				for (const record of events) {
					const ev = (record as any).event;
					const section = ev.section as string;
					if (section !== "subtensorModule" && section !== "SubtensorModule") continue;
					if ((ev.method as string) !== "IncentiveAlphaEmittedToMiners") continue;
					const data = ev.data.toJSON() as any[];
					// Event has 2 fields: netuid, emissions. polkadot.js may emit them as a tuple
					// (positional array) or as named fields — handle both.
					let netuidRaw: any;
					let emissionsRaw: any;
					if (Array.isArray(data)) {
						netuidRaw = data[0];
						emissionsRaw = data[1];
					} else if (data && typeof data === "object") {
						netuidRaw = (data as any).netuid;
						emissionsRaw = (data as any).emissions;
					}
					const netuid = Number(netuidRaw);
					if (!Number.isFinite(netuid)) continue;
					if (netuidFilter !== null && netuid !== netuidFilter) continue;
					const emissions = decodeEmissionsVec(emissionsRaw);
					rawEvents.push({ block: bn, netuid, emissions });
				}
			},
			(d, t) => onStatus({ kind: "progress", message: `scanning blocks`, done: d, total: t }),
		);
		onStatus({
			kind: "info",
			message: `Found ${rawEvents.length} IncentiveAlphaEmittedToMiners event(s)`,
		});

		// Group by netuid; collect unique (netuid, uid) pairs to resolve hotkeys.
		const byNetuid = new Map<number, typeof rawEvents>();
		for (const e of rawEvents) {
			const arr = byNetuid.get(e.netuid) ?? [];
			arr.push(e);
			byNetuid.set(e.netuid, arr);
		}

		// Resolve UID → hotkey, at the end block. UIDs can change over time
		// (deregistration), but for an aggregate view this snapshot is good enough.
		const endHash = (await api.rpc.chain.getBlockHash(endBlock)).toHex();
		const apiEnd = await api.at(endHash);

		type UidProbe = { netuid: number; uid: number };
		const uidProbes = new Set<string>();
		for (const e of rawEvents) {
			for (let uid = 0; uid < e.emissions.length; uid++) {
				if (e.emissions[uid] > 0n) uidProbes.add(`${e.netuid}|${uid}`);
			}
		}
		const probeList: UidProbe[] = Array.from(uidProbes).map((s) => {
			const [n, u] = s.split("|");
			return { netuid: parseInt(n), uid: parseInt(u) };
		});
		onStatus({
			kind: "info",
			message: `Resolving ${probeList.length} (netuid, uid) → hotkey at block ${endBlock}...`,
		});

		const hotkeyByKey = new Map<string, string>();
		await withLimit(
			probeList,
			concurrency,
			async (p) => {
				const k: any = await apiEnd.query.subtensorModule.keys(p.netuid, p.uid);
				const hk = k && !k.isEmpty ? k.toString() : "";
				if (hk) hotkeyByKey.set(`${p.netuid}|${p.uid}`, hk);
			},
			(d, t) => onStatus({ kind: "progress", message: `resolving hotkeys`, done: d, total: t }),
		);

		// Build per-netuid output.
		const netuids: NetuidData[] = [];
		const sortedNetuids = Array.from(byNetuid.keys()).sort((a, b) => a - b);
		let totalEvents = 0;
		let totalAlphaAll = 0n;

		for (const nu of sortedNetuids) {
			const arr = byNetuid.get(nu)!;
			arr.sort((a, b) => a.block - b.block);

			const events: EmissionEvent[] = [];
			let netuidTotal = 0n;
			const minerAgg = new Map<number, MinerTotal>();

			for (const e of arr) {
				let evTotal = 0n;
				const slices: MinerSlice[] = [];
				for (let uid = 0; uid < e.emissions.length; uid++) {
					const a = e.emissions[uid];
					if (a === 0n) continue;
					const hk = hotkeyByKey.get(`${e.netuid}|${uid}`) ?? "";
					slices.push({ uid, hotkey: hk, alpha: a });
					evTotal += a;
					const cur = minerAgg.get(uid);
					if (cur) {
						cur.total += a;
						cur.count += 1;
					} else {
						minerAgg.set(uid, { uid, hotkey: hk, total: a, count: 1 });
					}
				}
				slices.sort((x, y) => (y.alpha > x.alpha ? 1 : y.alpha < x.alpha ? -1 : 0));
				netuidTotal += evTotal;
				events.push({
					block: e.block,
					netuid: e.netuid,
					timestampMs: blockToMs(e.block),
					totalAlpha: evTotal,
					perMiner: slices,
				});
			}

			const miners = Array.from(minerAgg.values()).sort((a, b) =>
				b.total > a.total ? 1 : b.total < a.total ? -1 : 0,
			);

			netuids.push({ netuid: nu, events, miners, totalAlpha: netuidTotal });
			totalEvents += events.length;
			totalAlphaAll += netuidTotal;
		}

		onStatus({
			kind: "done",
			message: `Done. ${totalEvents} events across ${netuids.length} subnet(s).`,
		});
		await api.disconnect();

		return {
			meta: {
				rpc,
				startBlock,
				endBlock,
				blocksScanned,
				startMs: blockToMs(startBlock),
				endMs: blockToMs(endBlock),
			},
			netuids,
			totalEvents,
			totalAlpha: totalAlphaAll,
		};
	} catch (e) {
		try {
			await api.disconnect();
		} catch {}
		throw e;
	}
}

export function formatAlpha(v: bigint, precision = 6): string {
	const neg = v < 0n;
	const abs = neg ? -v : v;
	const i = abs / TAO_BASE;
	const f = abs % TAO_BASE;
	return `${neg ? "-" : ""}${i}.${f.toString().padStart(9, "0").slice(0, precision)}`;
}

export function alphaAsNumber(v: bigint): number {
	return alphaToNumber(v);
}
