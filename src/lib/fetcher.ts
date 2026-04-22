// Core forensic fetcher: for a given coldkey over a block window, samples balances per
// (hotkey, netuid) position, computes PSV / realized dividend, discovers child/parent links,
// and locates stake operations via binary-searched share transitions + event lookup.
//
// Ported from WIP/TS_SCRIPTS/src/dividends_anomaly.ts for browser use.

import { ApiPromise, WsProvider } from "@polkadot/api";
import { U64_MAX_N, decodeIdentity, formatTao, withLimit } from "./utils";
import {
	computeBalance,
	computePassiveDividend,
	computePoolApyPct,
	computeRealizedDividend,
} from "./math";

export const DEFAULT_RPC = "wss://subtensor-archive.app.minesight.co.uk";

// `from` / `to` accept a block number (pre-resolved) or a Date; the fetcher
// resolves dates on a single shared API connection — avoids multiple WS handshakes.
export type FetchBound = number | Date;

export type FetchParams = {
	rpc: string;
	coldkey: string;
	from: FetchBound;
	to: FetchBound;
	samplesPerDay: number;
	concurrency: number;
};

export type StatusKind = "info" | "progress" | "error" | "done";
export type StatusUpdate = {
	kind: StatusKind;
	message: string;
	done?: number;
	total?: number;
};

export type Sample = {
	block: number;
	alpha: bigint;
	totalShares: bigint;
	totalAlpha: bigint;
	balance: bigint;
	parents: { parent: string; proportionPct: number }[];
};

export type StakeOp = {
	block: number;
	blockHash: string;
	eventType: string;
	taoHuman?: string;
	alphaHuman?: string;
	deltaAlphaHuman: string;
	polkadotJsLink: string;
	xIndex: number; // fractional sample index for chart
};

export type PositionData = {
	hotkey: string;
	identityName: string;
	netuid: number;
	registeredOnSubnet: boolean;
	parents: { parent: string; proportionPct: number; parentIdentity: string }[];
	children: { child: string; uid: number | null; proportionPct: number; childIdentity: string }[];
	hasRegisteredChild: boolean;
	startBalance: number;
	endBalance: number;
	netChange: number;
	passiveDividend: number;
	realizedDividend: number;
	netFlow: number;
	poolApyPct: number | null;
	samples: Sample[];
	stakeOps: StakeOp[];
};

export type FetchResult = {
	meta: {
		coldkey: string;
		rpc: string;
		startBlock: number;
		endBlock: number;
		startHash: string;
		endHash: string;
		samplesPerDay: number;
		totalSamples: number;
	};
	summary: {
		positions: number;
		medianPoolApyPct: number;
		totalPassiveDividend: number;
		totalRealizedDividend: number;
	};
	labels: string[];
	blocks: number[];
	positions: PositionData[];
};

export async function fetchStakeData(
	params: FetchParams,
	onStatus: (s: StatusUpdate) => void,
): Promise<FetchResult> {
	const { rpc, coldkey, from, to, samplesPerDay, concurrency } = params;
	const BLOCKS_PER_DAY = 7200;
	const BLOCKS_PER_SAMPLE = Math.floor(BLOCKS_PER_DAY / samplesPerDay);

	onStatus({ kind: "info", message: `Connecting to ${rpc}...` });
	const api = await ApiPromise.create({ provider: new WsProvider(rpc) });
	try {
		// Resolve date inputs → blocks using head as anchor (single API connection).
		const head = await api.rpc.chain.getHeader();
		const headBlock = head.number.toNumber();
		const nowMs = Date.now();
		const toBlockFromDate = (d: Date) => {
			const diffBlocks = Math.floor((nowMs - d.getTime()) / 1000 / 12);
			return Math.max(1, headBlock - diffBlocks);
		};
		const startBlock = typeof from === "number" ? from : toBlockFromDate(from);
		const endBlock = typeof to === "number" ? to : toBlockFromDate(to);
		if (startBlock >= endBlock) {
			throw new Error(`Invalid range: start ${startBlock} ≥ end ${endBlock}`);
		}
		const TOTAL_SAMPLES = Math.floor((endBlock - startBlock) / BLOCKS_PER_SAMPLE) + 1;

		const startHash = (await api.rpc.chain.getBlockHash(startBlock)).toHex();
		const endHash = (await api.rpc.chain.getBlockHash(endBlock)).toHex();
		const apiStart = await api.at(startHash);
		const apiEnd = await api.at(endHash);
		onStatus({ kind: "info", message: `Window: block ${startBlock} → ${endBlock}` });

		// 1. Find hotkeys this coldkey has staked on
		onStatus({ kind: "info", message: "Fetching staking hotkeys..." });
		const hksEnd = (
			(await apiEnd.query.subtensorModule.stakingHotkeys(coldkey)) as any
		).toJSON() as string[];
		const hksStart = (
			(await apiStart.query.subtensorModule.stakingHotkeys(coldkey)) as any
		).toJSON() as string[];
		const hotkeys = Array.from(new Set([...(hksStart ?? []), ...(hksEnd ?? [])]));
		onStatus({ kind: "info", message: `Found ${hotkeys.length} staking hotkey(s)` });
		if (hotkeys.length === 0) throw new Error("No staking hotkeys found for this coldkey");

		// 2. Active subnets
		const netuidEntries = await apiEnd.query.subtensorModule.networksAdded.entries();
		const netuids: number[] = netuidEntries.map(([sk]: any) => (sk.args[0] as any).toNumber());
		netuids.sort((a, b) => a - b);
		onStatus({ kind: "info", message: `Active subnets: ${netuids.length}` });

		// 3. Find active positions
		onStatus({
			kind: "info",
			message: `Probing ${hotkeys.length * netuids.length} (hotkey, netuid) pairs for non-zero alpha...`,
		});
		type Probe = { hotkey: string; netuid: number };
		const probes: Probe[] = [];
		for (const hk of hotkeys) for (const nu of netuids) probes.push({ hotkey: hk, netuid: nu });

		const positionsSet = new Set<string>();
		await withLimit(
			probes,
			concurrency,
			async (p) => {
				const [aStart, aEnd] = await Promise.all([
					apiStart.query.subtensorModule.alpha(p.hotkey, coldkey, p.netuid),
					apiEnd.query.subtensorModule.alpha(p.hotkey, coldkey, p.netuid),
				]);
				const bs = (aStart as any).bits.toBigInt() as bigint;
				const be = (aEnd as any).bits.toBigInt() as bigint;
				if (bs > 0n || be > 0n) positionsSet.add(`${p.hotkey}|${p.netuid}`);
			},
			(d, t) => onStatus({ kind: "progress", message: `probing`, done: d, total: t }),
		);
		const positions = Array.from(positionsSet).map((s) => {
			const [hk, nu] = s.split("|");
			return { hotkey: hk, netuid: parseInt(nu) };
		});
		onStatus({ kind: "info", message: `Active positions: ${positions.length}` });

		if (positions.length === 0) {
			await api.disconnect();
			throw new Error("No active positions in the period");
		}

		// 4. Sample blocks (SAMPLES_PER_DAY per day)
		const sampleBlocks: number[] = [];
		for (let s = 0; s < TOTAL_SAMPLES; s++) sampleBlocks.push(startBlock + s * BLOCKS_PER_SAMPLE);
		if (sampleBlocks[sampleBlocks.length - 1] > endBlock)
			sampleBlocks[sampleBlocks.length - 1] = endBlock;
		onStatus({
			kind: "info",
			message: `Sampling ${sampleBlocks.length} points (${samplesPerDay}/day), every ${BLOCKS_PER_SAMPLE} blocks (~${((BLOCKS_PER_SAMPLE * 12) / 60).toFixed(0)}min)`,
		});

		const sampleHashes = await withLimit(sampleBlocks, concurrency, async (bn) =>
			(await api.rpc.chain.getBlockHash(bn)).toHex(),
		);
		const sampleApis = await withLimit(sampleHashes, concurrency, async (h) => await api.at(h));

		// 5. Metadata per hotkey: owner → identity, registered-on-subnet, child/parent links
		const uniqueHotkeys = Array.from(new Set(positions.map((p) => p.hotkey)));
		const identityByHotkey = new Map<string, string>();
		await withLimit(uniqueHotkeys, concurrency, async (hk) => {
			const owner = ((await apiEnd.query.subtensorModule.owner(hk)) as any).toString();
			const ckId = decodeIdentity(await apiEnd.query.subtensorModule.identitiesV2(owner));
			const hkId = ckId
				? null
				: decodeIdentity(await apiEnd.query.subtensorModule.identitiesV2(hk));
			identityByHotkey.set(hk, (ckId?.name as string) ?? (hkId?.name as string) ?? "");
		});

		const regByKey = new Map<string, boolean>();
		await withLimit(positions, concurrency, async (p) => {
			const uid = (await apiEnd.query.subtensorModule.uids(p.netuid, p.hotkey)) as any;
			regByKey.set(`${p.hotkey}|${p.netuid}`, !uid.isNone);
		});

		// parents (current, at end block)
		const parentsByKey = new Map<
			string,
			{ parent: string; proportionPct: number; parentIdentity: string }[]
		>();
		await withLimit(positions, concurrency, async (p) => {
			const pk = (await apiEnd.query.subtensorModule.parentKeys(p.hotkey, p.netuid)) as any;
			const raw = pk.toJSON() as Array<[string | number, string]> | null;
			const list = (raw ?? []).map(([prop, parent]) => {
				const propBig = typeof prop === "string" ? BigInt(prop) : BigInt(prop);
				const pct = (Number(propBig) / Number(U64_MAX_N)) * 100;
				return { parent, proportionPct: pct, parentIdentity: "" };
			});
			parentsByKey.set(`${p.hotkey}|${p.netuid}`, list);
		});

		// children (current, at end block)
		const childrenByKey = new Map<
			string,
			{ child: string; uid: number | null; proportionPct: number; childIdentity: string }[]
		>();
		await withLimit(positions, concurrency, async (p) => {
			const ck = (await apiEnd.query.subtensorModule.childKeys(p.hotkey, p.netuid)) as any;
			const raw = ck.toJSON() as Array<[string | number, string]> | null;
			const list: {
				child: string;
				uid: number | null;
				proportionPct: number;
				childIdentity: string;
			}[] = [];
			for (const [prop, child] of raw ?? []) {
				const propBig = typeof prop === "string" ? BigInt(prop) : BigInt(prop);
				const pct = (Number(propBig) / Number(U64_MAX_N)) * 100;
				const uid: any = await apiEnd.query.subtensorModule.uids(p.netuid, child);
				list.push({
					child,
					uid: uid.isNone ? null : (uid.unwrap() as any).toNumber(),
					proportionPct: pct,
					childIdentity: "",
				});
			}
			childrenByKey.set(`${p.hotkey}|${p.netuid}`, list);
		});

		// resolve identities for all parents + children
		const uniquePeers = Array.from(
			new Set([
				...Array.from(parentsByKey.values())
					.flat()
					.map((x) => x.parent),
				...Array.from(childrenByKey.values())
					.flat()
					.map((x) => x.child),
			]),
		);
		const idByPeer = new Map<string, string>();
		await withLimit(uniquePeers, concurrency, async (hk) => {
			const owner = ((await apiEnd.query.subtensorModule.owner(hk)) as any).toString();
			const ckId = decodeIdentity(await apiEnd.query.subtensorModule.identitiesV2(owner));
			const hkId = ckId
				? null
				: decodeIdentity(await apiEnd.query.subtensorModule.identitiesV2(hk));
			idByPeer.set(hk, (ckId?.name as string) ?? (hkId?.name as string) ?? "");
		});
		for (const list of parentsByKey.values())
			for (const x of list) x.parentIdentity = idByPeer.get(x.parent) ?? "";
		for (const list of childrenByKey.values())
			for (const x of list) x.childIdentity = idByPeer.get(x.child) ?? "";

		// 6. Fetch samples
		type Job = { posIdx: number; sampleIdx: number };
		const jobs: Job[] = [];
		for (let p = 0; p < positions.length; p++) {
			for (let s = 0; s < sampleApis.length; s++) jobs.push({ posIdx: p, sampleIdx: s });
		}
		onStatus({
			kind: "info",
			message: `Fetching ${jobs.length} samples (${positions.length} positions × ${sampleApis.length} points)...`,
		});

		const samplesMatrix: Sample[][] = positions.map(() => new Array(sampleApis.length) as Sample[]);
		await withLimit(
			jobs,
			concurrency,
			async (job) => {
				const pos = positions[job.posIdx];
				const apiAt = sampleApis[job.sampleIdx];
				const [alphaVal, tsVal, taVal, pkVal] = await Promise.all([
					apiAt.query.subtensorModule.alpha(pos.hotkey, coldkey, pos.netuid),
					apiAt.query.subtensorModule.totalHotkeyShares(pos.hotkey, pos.netuid),
					apiAt.query.subtensorModule.totalHotkeyAlpha(pos.hotkey, pos.netuid),
					apiAt.query.subtensorModule.parentKeys(pos.hotkey, pos.netuid),
				]);
				const alpha = (alphaVal as any).bits.toBigInt() as bigint;
				const totalShares = (tsVal as any).bits.toBigInt() as bigint;
				const totalAlpha = (taVal as any).toBigInt() as bigint;
				const balance = computeBalance(alpha, totalShares, totalAlpha);
				const rawParents = (pkVal as any).toJSON() as Array<[string | number, string]> | null;
				const parents = (rawParents ?? []).map(([prop, parent]) => {
					const propBig = typeof prop === "string" ? BigInt(prop) : BigInt(prop);
					return {
						parent,
						proportionPct: (Number(propBig) / Number(U64_MAX_N)) * 100,
					};
				});
				samplesMatrix[job.posIdx][job.sampleIdx] = {
					block: sampleBlocks[job.sampleIdx],
					alpha,
					totalShares,
					totalAlpha,
					balance,
					parents,
				};
			},
			(d, t) => onStatus({ kind: "progress", message: `sample`, done: d, total: t }),
		);

		// 7. Stake ops — detect share transitions + binary search + event lookup
		type Candidate = {
			posIdx: number;
			hotkey: string;
			netuid: number;
			loBlock: number;
			hiBlock: number;
			toAlpha: bigint;
			balanceDelta: bigint;
		};
		const candidates: Candidate[] = [];
		for (let p = 0; p < positions.length; p++) {
			const sms = samplesMatrix[p];
			for (let s = 1; s < sms.length; s++) {
				if (sms[s - 1].alpha !== sms[s].alpha) {
					candidates.push({
						posIdx: p,
						hotkey: positions[p].hotkey,
						netuid: positions[p].netuid,
						loBlock: sms[s - 1].block,
						hiBlock: sms[s].block,
						toAlpha: sms[s].alpha,
						balanceDelta: sms[s].balance - sms[s - 1].balance,
					});
				}
			}
		}
		onStatus({
			kind: "info",
			message: `Detected ${candidates.length} share-transitions — locating exact blocks...`,
		});

		type LocatedOp = {
			posIdx: number;
			block: number;
			blockHash: string;
			balanceDelta: bigint;
		};
		const located: LocatedOp[] = await withLimit(
			candidates,
			concurrency,
			async (c) => {
				let lo = c.loBlock;
				let hi = c.hiBlock;
				while (lo + 1 < hi) {
					const mid = Math.floor((lo + hi) / 2);
					const hash = (await api.rpc.chain.getBlockHash(mid)).toHex();
					const apiAt = await api.at(hash);
					const a = (
						(await apiAt.query.subtensorModule.alpha(c.hotkey, coldkey, c.netuid)) as any
					).bits.toBigInt() as bigint;
					if (a === c.toAlpha) hi = mid;
					else lo = mid;
				}
				const hash = (await api.rpc.chain.getBlockHash(hi)).toHex();
				return { posIdx: c.posIdx, block: hi, blockHash: hash, balanceDelta: c.balanceDelta };
			},
			(d, t) => onStatus({ kind: "progress", message: `locating`, done: d, total: t }),
		);

		// Fetch events at each unique block
		const uniqueEventBlocks = Array.from(new Set(located.map((l) => l.block)));
		onStatus({
			kind: "info",
			message: `Fetching events at ${uniqueEventBlocks.length} unique blocks...`,
		});
		const eventsByBlock = new Map<number, Array<{ method: string; data: any[] }>>();
		await withLimit(uniqueEventBlocks, concurrency, async (bn) => {
			const hash = (await api.rpc.chain.getBlockHash(bn)).toHex();
			const apiAt = await api.at(hash);
			const events: any = await apiAt.query.system.events();
			const parsed: Array<{ method: string; data: any[] }> = [];
			for (const record of events) {
				const ev = (record as any).event;
				const section = ev.section as string;
				if (section !== "subtensorModule" && section !== "SubtensorModule") continue;
				const method = ev.method as string;
				if (
					![
						"StakeAdded",
						"StakeRemoved",
						"StakeMoved",
						"StakeTransferred",
						"StakeSwapped",
					].includes(method)
				)
					continue;
				parsed.push({ method, data: ev.data.toJSON() as any[] });
			}
			eventsByBlock.set(bn, parsed);
		});

		const stakeOpsByPos = new Map<number, StakeOp[]>();
		for (const l of located) {
			const pos = positions[l.posIdx];
			const events = eventsByBlock.get(l.block) ?? [];
			let eventType = "unknown";
			let taoHuman: string | undefined;
			let alphaHuman: string | undefined;
			// Event schemas (keep in sync with pallets/subtensor/src/macros/events.rs):
			//   StakeAdded      (coldkey, hotkey, tao, alpha, netuid, fee)                        — 6 fields
			//   StakeRemoved    (coldkey, hotkey, tao, alpha, netuid, fee)                        — 6 fields
			//   StakeMoved      (coldkey, fromHotkey, fromNetuid, toHotkey, toNetuid, tao)        — 6 fields
			//   StakeTransferred(fromCold, toCold,  hotkey,      fromNetuid, toNetuid, tao)       — 6 fields
			//   StakeSwapped    (coldkey, hotkey,   fromNetuid, toNetuid, tao)                    — 5 fields
			// If the runtime ever reshapes these, the `hasLen` check leaves eventType=unknown
			// rather than matching on wrong indices.
			const hasLen = (d: any[], n: number) => Array.isArray(d) && d.length >= n;
			const bi = (v: any): bigint => (typeof v === "string" ? BigInt(v) : BigInt(v ?? 0));

			for (const e of events) {
				const d = e.data;
				if (e.method === "StakeAdded" || e.method === "StakeRemoved") {
					if (!hasLen(d, 5)) continue;
					if (d[0] === coldkey && d[1] === pos.hotkey && Number(d[4]) === pos.netuid) {
						eventType = e.method;
						taoHuman = formatTao(bi(d[2]));
						alphaHuman = formatTao(bi(d[3]));
						break;
					}
				} else if (e.method === "StakeMoved") {
					if (!hasLen(d, 6)) continue;
					if (d[0] !== coldkey) continue;
					const isOut = d[1] === pos.hotkey && Number(d[2]) === pos.netuid;
					const isIn = d[3] === pos.hotkey && Number(d[4]) === pos.netuid;
					if (isOut || isIn) {
						eventType = isOut ? "StakeMoved(out)" : "StakeMoved(in)";
						taoHuman = formatTao(bi(d[5]));
						break;
					}
				} else if (e.method === "StakeTransferred") {
					if (!hasLen(d, 6)) continue;
					if (d[0] !== coldkey && d[1] !== coldkey) continue;
					const isOut = d[0] === coldkey && d[2] === pos.hotkey && Number(d[3]) === pos.netuid;
					const isIn = d[1] === coldkey && d[2] === pos.hotkey && Number(d[4]) === pos.netuid;
					if (isOut || isIn) {
						eventType = isOut ? "StakeTransferred(out)" : "StakeTransferred(in)";
						taoHuman = formatTao(bi(d[5]));
						break;
					}
				} else if (e.method === "StakeSwapped") {
					if (!hasLen(d, 5)) continue;
					if (d[0] !== coldkey || d[1] !== pos.hotkey) continue;
					const isOut = Number(d[2]) === pos.netuid;
					const isIn = Number(d[3]) === pos.netuid;
					if (isOut || isIn) {
						eventType = isOut ? "StakeSwapped(out)" : "StakeSwapped(in)";
						taoHuman = formatTao(bi(d[4]));
						break;
					}
				}
			}
			const encodedRpc = encodeURIComponent(rpc);
			const op: StakeOp = {
				block: l.block,
				blockHash: l.blockHash,
				eventType,
				taoHuman,
				alphaHuman,
				deltaAlphaHuman: formatTao(l.balanceDelta),
				polkadotJsLink: `https://polkadot.js.org/apps/?rpc=${encodedRpc}#/explorer/query/${l.block}`,
				xIndex: (l.block - startBlock) / BLOCKS_PER_SAMPLE,
			};
			const arr = stakeOpsByPos.get(l.posIdx) ?? [];
			arr.push(op);
			stakeOpsByPos.set(l.posIdx, arr);
		}
		for (const arr of stakeOpsByPos.values()) arr.sort((a, b) => a.block - b.block);

		// 8. Build final position records
		const labels = sampleBlocks.map((_, i) => `d${(i / samplesPerDay).toFixed(1)}`);
		const positionData: PositionData[] = positions.map((pos, i) => {
			const samples = samplesMatrix[i];
			const first = samples[0];
			const last = samples[samples.length - 1];
			const days = (endBlock - startBlock) / BLOCKS_PER_DAY;
			const poolApyPct = computePoolApyPct(
				first.totalAlpha,
				first.totalShares,
				last.totalAlpha,
				last.totalShares,
				days,
			);
			const passiveDividendRao = computePassiveDividend(
				first.alpha,
				first.totalAlpha,
				first.totalShares,
				last.totalAlpha,
				last.totalShares,
			);
			const realizedDividendRao = computeRealizedDividend(samples);
			const netChange = last.balance - first.balance;
			const netFlow = netChange - realizedDividendRao;

			const parents = parentsByKey.get(`${pos.hotkey}|${pos.netuid}`) ?? [];
			const children = childrenByKey.get(`${pos.hotkey}|${pos.netuid}`) ?? [];

			return {
				hotkey: pos.hotkey,
				identityName: identityByHotkey.get(pos.hotkey) ?? "",
				netuid: pos.netuid,
				registeredOnSubnet: regByKey.get(`${pos.hotkey}|${pos.netuid}`) ?? false,
				parents,
				children,
				hasRegisteredChild: children.some((c) => c.uid !== null),
				startBalance: Number(first.balance) / 1e9,
				endBalance: Number(last.balance) / 1e9,
				netChange: Number(netChange) / 1e9,
				passiveDividend: Number(passiveDividendRao) / 1e9,
				realizedDividend: Number(realizedDividendRao) / 1e9,
				netFlow: Number(netFlow) / 1e9,
				poolApyPct,
				samples,
				stakeOps: stakeOpsByPos.get(i) ?? [],
			};
		});

		const apys = positionData
			.map((r) => r.poolApyPct)
			.filter((v): v is number => v !== null)
			.sort((a, b) => a - b);
		const medianApy = apys.length ? apys[Math.floor(apys.length / 2)] : 0;

		onStatus({ kind: "done", message: `Done. ${positionData.length} positions analyzed.` });

		await api.disconnect();

		return {
			meta: {
				coldkey,
				rpc,
				startBlock,
				endBlock,
				startHash,
				endHash,
				samplesPerDay,
				totalSamples: sampleBlocks.length,
			},
			summary: {
				positions: positionData.length,
				medianPoolApyPct: medianApy,
				totalPassiveDividend: positionData.reduce((a, r) => a + r.passiveDividend, 0),
				totalRealizedDividend: positionData.reduce((a, r) => a + r.realizedDividend, 0),
			},
			labels,
			blocks: sampleBlocks,
			positions: positionData,
		};
	} catch (e) {
		try {
			await api.disconnect();
		} catch {}
		throw e;
	}
}
