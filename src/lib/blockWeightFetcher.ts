// Scans a block range and reconstructs per-block weight utilization plus, optionally,
// a per-extrinsic / per-call attribution of where that weight went.
//
// Nothing here needs a runtime change — the data is already on-chain:
//
//   * System::BlockWeight (storage) — the authoritative weight CONSUMED by a block,
//     split per dispatch class { normal, operational, mandatory }. Read at the block
//     hash this is the final post-block value (base block weight + every extrinsic +
//     on_initialize/on_finalize). This drives the "how full is the block" line.
//
//   * system.blockWeights (const) — the LIMITS: maxBlock (the hard ceiling) and the
//     per-class maxTotal (normal class is capped at NORMAL_DISPATCH_RATIO of maxBlock).
//
//   * system.events() — every extrinsic emits System.ExtrinsicSuccess/Failed carrying
//     a DispatchInfo whose `weight` is the POST-dispatch (refunded) actual weight that
//     was billed. Pairing each event's ApplyExtrinsic(index) with the block body's
//     extrinsics[index].method gives us "which call took how much".
//
// On subtensor the weight `proofSize` dimension is configured unbounded (u64::MAX), so
// only `refTime` (compute + storage read/write cost via RocksDbWeight) is a meaningful
// "fullness" measure. We surface refTime utilization and keep proofSize as raw bytes.

import { ApiPromise, WsProvider } from "@polkadot/api";
import { BLOCK_TIME_S, withLimit } from "./utils";
import type { FetchBound, StatusUpdate } from "./fetcher";

export type BlockWeightParams = {
	rpc: string;
	from: FetchBound;
	to: FetchBound;
	concurrency: number;
	// When true, also read each block body + events to attribute weight per call.
	// Roughly triples the RPC work per block, so it's a toggle.
	attribute: boolean;
};

export type WeightDims = { refTime: bigint; proofSize: bigint };

export type BlockWeightSample = {
	block: number;
	timestampMs: number;
	normal: WeightDims;
	operational: WeightDims;
	mandatory: WeightDims;
	totalRefTime: bigint; // normal + operational + mandatory
	utilPct: number; // totalRefTime / maxBlock.refTime * 100
	normalPct: number; // normal.refTime / normalMaxTotal.refTime * 100
	numExtrinsics: number; // 0 when attribution is off
	topCall: { name: string; refTime: bigint } | null; // heaviest extrinsic in this block
};

export type CallAgg = {
	name: string; // e.g. "subtensorModule.add_stake"
	refTime: bigint; // summed actual weight across the window
	count: number; // number of extrinsics
	share: number; // refTime / totalExtrinsicRefTime * 100
};

// A single heavy extrinsic, for the "what pulled the most in one shot" list.
export type HeavyExtrinsic = {
	block: number;
	index: number;
	name: string;
	refTime: bigint;
	pctOfMaxBlock: number;
};

export type BlockWeightResult = {
	meta: {
		rpc: string;
		startBlock: number;
		endBlock: number;
		blocksScanned: number;
		startMs: number;
		endMs: number;
		maxBlockRefTime: bigint;
		normalMaxRefTime: bigint;
		attribute: boolean;
	};
	samples: BlockWeightSample[]; // ordered by block asc
	callAggs: CallAgg[]; // sorted by refTime desc (empty when attribution off)
	heaviest: HeavyExtrinsic[]; // top individual extrinsics, refTime desc
	totalExtrinsicRefTime: bigint;
	avgUtilPct: number;
	maxUtilPct: number;
};

// Weight may be a v2 struct { refTime, proofSize } or, on very old runtimes, a bare u64.
// Subtensor is v2, but stay defensive so a metadata quirk can't throw the whole scan.
function readWeight(w: any): WeightDims {
	if (w == null) return { refTime: 0n, proofSize: 0n };
	if (w.refTime != null) {
		return {
			refTime: toBig(w.refTime),
			proofSize: w.proofSize != null ? toBig(w.proofSize) : 0n,
		};
	}
	return { refTime: toBig(w), proofSize: 0n };
}

function toBig(v: any): bigint {
	try {
		if (typeof v === "bigint") return v;
		if (v?.toBigInt) return v.toBigInt();
		return BigInt(v.toString());
	} catch {
		return 0n;
	}
}

export async function fetchBlockWeights(
	params: BlockWeightParams,
	onStatus: (s: StatusUpdate) => void,
): Promise<BlockWeightResult> {
	const { rpc, from, to, concurrency, attribute } = params;

	onStatus({ kind: "info", message: `Connecting to ${rpc}...` });
	const api = await ApiPromise.create({ provider: new WsProvider(rpc) });
	try {
		// Limits come from the runtime constant — read once, they don't change per block
		// (a runtime upgrade could, but within one scan window we treat them as fixed).
		const bw: any = api.consts.system.blockWeights;
		const maxBlockRefTime = toBig(bw?.maxBlock?.refTime);
		const normalMaxRefTime =
			toBig(bw?.perClass?.normal?.maxTotal?.value?.refTime) ||
			toBig(bw?.perClass?.normal?.maxTotal?.refTime) ||
			maxBlockRefTime;
		if (maxBlockRefTime === 0n) {
			throw new Error("Could not read system.blockWeights.maxBlock.refTime from chain metadata");
		}
		onStatus({
			kind: "info",
			message: `Limits: maxBlock refTime ${fmtRefTime(maxBlockRefTime)}, normal-class cap ${fmtRefTime(normalMaxRefTime)}`,
		});

		// Anchor date→block on the head's chain timestamp (mirrors emissionsFetcher).
		const head = await api.rpc.chain.getHeader();
		const headBlock = head.number.toNumber();
		const headHash = (await api.rpc.chain.getBlockHash(headBlock)).toHex();
		const apiHead = await api.at(headHash);
		const headTsMs = ((await apiHead.query.timestamp.now()) as any).toNumber();

		const toBlockFromDate = (d: Date) => {
			const diffBlocks = Math.floor((headTsMs - d.getTime()) / 1000 / BLOCK_TIME_S);
			return Math.max(1, Math.min(headBlock, headBlock - diffBlocks));
		};
		const startBlock = typeof from === "number" ? from : toBlockFromDate(from);
		const endBlock = typeof to === "number" ? to : toBlockFromDate(to);
		if (startBlock >= endBlock) {
			throw new Error(
				`Invalid range: start ${startBlock} ≥ end ${endBlock} (chain head is block ${headBlock}; switch From/To to "block" mode if the chain is too short for the date window)`,
			);
		}
		const blockToMs = (b: number) => headTsMs - (headBlock - b) * BLOCK_TIME_S * 1000;
		const blocksScanned = endBlock - startBlock + 1;
		onStatus({
			kind: "info",
			message: `Window: block ${startBlock} → ${endBlock} (${blocksScanned} blocks)${attribute ? ", per-call attribution ON" : ""}`,
		});

		const blockNumbers: number[] = [];
		for (let b = startBlock; b <= endBlock; b++) blockNumbers.push(b);

		const callAgg = new Map<string, { refTime: bigint; count: number }>();
		const heaviest: HeavyExtrinsic[] = [];

		const samples = await withLimit(
			blockNumbers,
			concurrency,
			async (bn): Promise<BlockWeightSample> => {
				const hash = (await api.rpc.chain.getBlockHash(bn)).toHex();
				const apiAt = await api.at(hash);

				// Authoritative consumed weight for the block.
				const consumed: any = await apiAt.query.system.blockWeight();
				const normal = readWeight(consumed?.normal);
				const operational = readWeight(consumed?.operational);
				const mandatory = readWeight(consumed?.mandatory);
				const totalRefTime = normal.refTime + operational.refTime + mandatory.refTime;

				let numExtrinsics = 0;
				let topCall: { name: string; refTime: bigint } | null = null;

				if (attribute) {
					// Block body gives us extrinsic index → call name; events give the
					// post-dispatch actual weight per extrinsic.
					const [signed, events]: [any, any] = await Promise.all([
						api.rpc.chain.getBlock(hash),
						apiAt.query.system.events(),
					]);
					const exts = signed.block.extrinsics;
					numExtrinsics = exts.length;

					for (const record of events) {
						const phase = record.phase;
						if (!phase?.isApplyExtrinsic) continue;
						const ev = record.event;
						const method = ev.method as string;
						if (method !== "ExtrinsicSuccess" && method !== "ExtrinsicFailed") continue;

						const idx = phase.asApplyExtrinsic.toNumber();
						// DispatchInfo is the last field of both events.
						const data = ev.data;
						const dispatchInfo: any = data[data.length - 1];
						const refTime = toBig(dispatchInfo?.weight?.refTime ?? dispatchInfo?.weight);

						const call = exts[idx]?.method;
						const name = call ? `${call.section}.${call.method}` : `extrinsic#${idx}`;

						const cur = callAgg.get(name);
						if (cur) {
							cur.refTime += refTime;
							cur.count += 1;
						} else {
							callAgg.set(name, { refTime, count: 1 });
						}

						if (!topCall || refTime > topCall.refTime) topCall = { name, refTime };

						heaviest.push({
							block: bn,
							index: idx,
							name,
							refTime,
							pctOfMaxBlock: maxBlockRefTime > 0n ? pct(refTime, maxBlockRefTime) : 0,
						});
					}
				}

				return {
					block: bn,
					timestampMs: blockToMs(bn),
					normal,
					operational,
					mandatory,
					totalRefTime,
					utilPct: pct(totalRefTime, maxBlockRefTime),
					normalPct: normalMaxRefTime > 0n ? pct(normal.refTime, normalMaxRefTime) : 0,
					numExtrinsics,
					topCall,
				};
			},
			(d, t) => onStatus({ kind: "progress", message: `scanning blocks`, done: d, total: t }),
		);

		// Aggregate call table.
		let totalExtrinsicRefTime = 0n;
		for (const { refTime } of callAgg.values()) totalExtrinsicRefTime += refTime;
		const callAggs: CallAgg[] = Array.from(callAgg.entries())
			.map(([name, v]) => ({
				name,
				refTime: v.refTime,
				count: v.count,
				share: totalExtrinsicRefTime > 0n ? pct(v.refTime, totalExtrinsicRefTime) : 0,
			}))
			.sort((a, b) => (b.refTime > a.refTime ? 1 : b.refTime < a.refTime ? -1 : 0));

		// Keep only the heaviest individual extrinsics.
		heaviest.sort((a, b) => (b.refTime > a.refTime ? 1 : b.refTime < a.refTime ? -1 : 0));
		const heaviestTop = heaviest.slice(0, 50);

		let utilSum = 0;
		let maxUtil = 0;
		for (const s of samples) {
			utilSum += s.utilPct;
			if (s.utilPct > maxUtil) maxUtil = s.utilPct;
		}

		onStatus({
			kind: "done",
			message: `Done. ${samples.length} blocks, avg util ${(utilSum / samples.length).toFixed(2)}%, peak ${maxUtil.toFixed(2)}%.`,
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
				maxBlockRefTime,
				normalMaxRefTime,
				attribute,
			},
			samples,
			callAggs,
			heaviest: heaviestTop,
			totalExtrinsicRefTime,
			avgUtilPct: samples.length ? utilSum / samples.length : 0,
			maxUtilPct: maxUtil,
		};
	} catch (e) {
		try {
			await api.disconnect();
		} catch {}
		throw e;
	}
}

function pct(part: bigint, whole: bigint): number {
	if (whole === 0n) return 0;
	// Scale into number space with 4 decimals of headroom before dividing.
	return Number((part * 1_000_000n) / whole) / 10_000;
}

// refTime is in picoseconds of reference compute (1e12 = 1s). Render as ms/s.
export function fmtRefTime(refTime: bigint): string {
	const ms = Number(refTime) / 1_000_000_000;
	if (ms >= 1000) return `${(ms / 1000).toFixed(3)} s`;
	if (ms >= 1) return `${ms.toFixed(2)} ms`;
	return `${(ms * 1000).toFixed(1)} µs`;
}
