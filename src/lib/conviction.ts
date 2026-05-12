// Conviction lock math + chain readers.
//
// Mirror of subtensor's pallets/subtensor/src/staking/lock.rs — exponential
// maturity for conviction (τ = MaturityRate blocks), exponential decay for the
// post-unlock quarantine (τ = UnlockRate blocks). At most ONE lock per
// (coldkey, netuid); we read it directly from storage and roll forward in JS.

import type { ApiPromise } from "@polkadot/api";
import { computeBalance } from "./math";
import { TAO_BASE, mergeShares, withLimit } from "./utils";

// Stored LockState as it appears on-chain. `conviction` is encoded as U64F64
// (substrate-fixed, bits / 2^64). We keep the raw bigint bits here and only
// downscale at display time.
export type LockState = {
	lockedMass: bigint; // rao
	unlockedMass: bigint; // rao
	convictionBits: bigint; // U64F64 raw bits (rao × 2^64)
	lastUpdate: number; // block number
	hotkey: string; // which hotkey this lock targets
};

// One sample for the chart. All amounts in α (1 α = 1e9 rao).
export type LockSample = {
	block: number;
	tDays: number; // days since chart origin
	locked: number;
	unlocked: number;
	conviction: number;
	available: number;
};

export type LockContext = {
	tauMaturity: number; // blocks
	tauUnlock: number; // blocks
	blockTimeMs: number;
	headBlock: number;
	lock: LockState | null;
	totalAlphaOnSubnetRao: bigint; // Σ alpha across hotkeys for this (coldkey, netuid)
};

// --- pure math --------------------------------------------------------------

// Mirrors lock.rs::exp_decay. The runtime clamps dt/τ at 40 to keep U64F64
// from blowing up; we do the same so projection/history match on-chain values.
export function expDecay(dt: number, tau: number): number {
	if (tau === 0 || dt === 0) {
		if (dt === 0) return 1;
		return 0;
	}
	const ratio = -dt / tau;
	const clamped = ratio < -40 ? -40 : ratio;
	return Math.exp(clamped);
}

// Mirrors lock.rs::roll_forward_lock + calculate_matured_values.
// Returns matured (locked, unlocked, conviction) for a given `now`, given a
// stored LockState and the two τ parameters. `locked` is constant (only
// changes on user actions); `unlocked` decays toward 0 with τ_unlock;
// `conviction` matures toward `locked` with τ_maturity.
export function rollForward(
	lock: LockState,
	now: number,
	tauMaturity: number,
	tauUnlock: number,
): { lockedRao: bigint; unlockedRao: bigint; convictionRao: number } {
	if (now <= lock.lastUpdate) {
		// Snapshot is from the future relative to `now` — return as-is.
		return {
			lockedRao: lock.lockedMass,
			unlockedRao: lock.unlockedMass,
			convictionRao: Number(lock.convictionBits) / Math.pow(2, 64),
		};
	}
	const dt = now - lock.lastUpdate;
	const decay = expDecay(dt, tauMaturity);
	const unlockDecay = expDecay(dt, tauUnlock);

	// Match the runtime's discrete-time formula:
	//   conviction_new = m − (m − conviction_stored) × decay
	//   unlocked_new   = unlocked_stored × unlock_decay
	const mRao = Number(lock.lockedMass);
	const c0Rao = Number(lock.convictionBits) / Math.pow(2, 64);
	const convictionRao = mRao - (mRao - c0Rao) * decay;

	const u0Rao = Number(lock.unlockedMass);
	const unlockedRao = BigInt(Math.floor(u0Rao * unlockDecay));

	return {
		lockedRao: lock.lockedMass,
		unlockedRao,
		convictionRao,
	};
}

// --- chain reads ------------------------------------------------------------

// Block time at the head block, in ms.
// Tries Aura (slotDuration), then Babe (expectedBlockTime), then
// timestamp.minimumPeriod × 2 (substrate default), with 12000 as last resort.
// Reading from constants makes fast-runtime "just work" — no UI knob needed.
export async function getBlockTimeMs(api: ApiPromise): Promise<number> {
	const consts: any = api.consts as any;
	const candidates = [
		() => consts.aura?.slotDuration?.toNumber?.(),
		() => consts.babe?.expectedBlockTime?.toNumber?.(),
		() => {
			const mp = consts.timestamp?.minimumPeriod?.toNumber?.();
			return typeof mp === "number" ? mp * 2 : undefined;
		},
	];
	for (const get of candidates) {
		try {
			const v = get();
			if (typeof v === "number" && v > 0) return v;
		} catch {}
	}
	return 12000;
}

// Decodes a Lock storage entry — returns null if no lock exists for that
// (coldkey, netuid, *). The pallet enforces at most one hotkey per coldkey
// per subnet, so we iterate the prefix and pick the first.
async function readLockEntry(
	apiAt: any,
	coldkey: string,
	netuid: number,
): Promise<LockState | null> {
	const entries: any = await apiAt.query.subtensorModule.lock.entries(coldkey, netuid);
	if (!entries || entries.length === 0) return null;
	const [key, value] = entries[0];
	if (value.isNone) return null;
	const v = value.unwrap();
	const hotkey = key.args[2].toString();
	return decodeLockState(v, hotkey);
}

// Same shape, addressed by the specific hotkey. Used when the caller supplied
// a hotkey: lets us flag mismatches if the actual lock targets a different one.
// NMap with three keys is decorated as a positional-args call in polkadot.js
// (not an array tuple), so pass them separately.
async function readLockExact(
	apiAt: any,
	coldkey: string,
	netuid: number,
	hotkey: string,
): Promise<LockState | null> {
	const opt: any = await apiAt.query.subtensorModule.lock(coldkey, netuid, hotkey);
	if (!opt || opt.isNone) return null;
	return decodeLockState(opt.unwrap(), hotkey);
}

function decodeLockState(v: any, hotkey: string): LockState {
	return {
		lockedMass: v.lockedMass.toBigInt() as bigint,
		unlockedMass: v.unlockedMass.toBigInt() as bigint,
		// U64F64 inner is `bits: u128` — polkadot.js exposes it as either a
		// nested struct or directly. Handle both.
		convictionBits: (v.conviction.bits ?? v.conviction).toBigInt() as bigint,
		lastUpdate: Number(v.lastUpdate.toBigInt?.() ?? v.lastUpdate.toNumber()),
		hotkey,
	};
}

// Returns the user's actual α balance in this (hotkey, coldkey, netuid)
// position in rao — not raw share bits. Shares × (totalAlpha / totalShares).
// PR #2353 split alpha storage into legacy U64F64 and V2 SafeFloat; both
// versions are merged the same way fetcher.ts does it.
async function readAlphaBalanceForHotkey(
	apiAt: any,
	hotkey: string,
	coldkey: string,
	netuid: number,
): Promise<bigint> {
	const [aV1, aV2, tsV1, tsV2, taVal] = await Promise.all([
		apiAt.query.subtensorModule.alpha(hotkey, coldkey, netuid),
		apiAt.query.subtensorModule.alphaV2
			? apiAt.query.subtensorModule.alphaV2(hotkey, coldkey, netuid)
			: Promise.resolve(null),
		apiAt.query.subtensorModule.totalHotkeyShares(hotkey, netuid),
		apiAt.query.subtensorModule.totalHotkeySharesV2
			? apiAt.query.subtensorModule.totalHotkeySharesV2(hotkey, netuid)
			: Promise.resolve(null),
		apiAt.query.subtensorModule.totalHotkeyAlpha(hotkey, netuid),
	]);
	const shares = mergeShares(aV1, aV2);
	const totalShares = mergeShares(tsV1, tsV2);
	const totalAlpha = (taVal as any).toBigInt() as bigint;
	return computeBalance(shares, totalShares, totalAlpha);
}

// Σ alpha across all hotkeys the coldkey is staked through on this subnet.
// available_stake() in the runtime is `this − lockedMass − unlockedMass`.
async function readTotalAlphaOnSubnet(
	apiAt: any,
	coldkey: string,
	netuid: number,
	concurrency: number,
	onStatus?: StatusFn,
): Promise<bigint> {
	const hks = ((await apiAt.query.subtensorModule.stakingHotkeys(coldkey)) as any).toJSON() as
		| string[]
		| null;
	if (!hks || hks.length === 0) return 0n;
	onStatus?.(`Summing α across ${hks.length} hotkey(s)...`);
	const alphas = await withLimit(
		hks,
		concurrency,
		(hk) => readAlphaBalanceForHotkey(apiAt, hk, coldkey, netuid),
		(done, total) => onStatus?.(`hotkeys`, done, total),
	);
	return alphas.reduce((acc, x) => acc + x, 0n);
}

// One-shot read of everything needed for projection (current state at head).
// `onStatus` is called between sub-steps so the UI doesn't appear frozen on
// slow RPCs (chain constants → head hash → lock storage → per-hotkey alpha).
export async function loadLockContext(
	api: ApiPromise,
	coldkey: string,
	netuid: number,
	suppliedHotkey: string | null,
	concurrency: number,
	onStatus?: StatusFn,
): Promise<LockContext> {
	onStatus?.("Reading chain head + τ constants...");
	const [headHeader, blockTimeMs, maturityRaw, unlockRaw] = await Promise.all([
		api.rpc.chain.getHeader(),
		getBlockTimeMs(api),
		api.query.subtensorModule.maturityRate(),
		api.query.subtensorModule.unlockRate(),
	]);
	const headBlock = headHeader.number.toNumber();
	onStatus?.(`Resolving head block hash (#${headBlock})...`);
	const headHash = (await api.rpc.chain.getBlockHash(headBlock)).toHex();
	const apiAt = await api.at(headHash);

	// If hotkey was supplied, look it up directly so we can detect mismatches
	// later; otherwise fall back to prefix-iter (returns whichever single
	// hotkey is currently locked, if any).
	onStatus?.("Reading lock storage...");
	const lock = suppliedHotkey
		? ((await readLockExact(apiAt, coldkey, netuid, suppliedHotkey)) ??
			(await readLockEntry(apiAt, coldkey, netuid)))
		: await readLockEntry(apiAt, coldkey, netuid);

	const totalAlphaOnSubnetRao = await readTotalAlphaOnSubnet(
		apiAt,
		coldkey,
		netuid,
		concurrency,
		onStatus,
	);

	return {
		tauMaturity: Number((maturityRaw as any).toBigInt?.() ?? (maturityRaw as any).toNumber()),
		tauUnlock: Number((unlockRaw as any).toBigInt?.() ?? (unlockRaw as any).toNumber()),
		blockTimeMs,
		headBlock,
		lock,
		totalAlphaOnSubnetRao,
	};
}

// --- what-if simulation -----------------------------------------------------

export type UnlockEvent = {
	atBlock: number; // block at which the simulated unlock_stake fires
	amountRao: bigint;
};

// Apply the on-chain `unlock_stake(amount)` effect at an arbitrary block,
// returning a context whose `lock` field reflects the post-unlock state with
// lastUpdate=atBlock. Mirrors pallets/subtensor/src/staking/lock.rs:
// do_unlock_stake — locked −= amount, unlocked += amount, conviction is
// rolled forward to `atBlock` then `saturating_sub`-ed by amount.
//
// `atBlock` is clamped to be ≥ ctx.headBlock (we can't simulate in the past).
export function simulateUnlockAt(
	ctx: LockContext,
	amountRao: bigint,
	atBlock: number,
): LockContext {
	if (!ctx.lock || amountRao <= 0n) return ctx;
	const eventBlock = Math.max(atBlock, ctx.headBlock);
	const rolled = rollForward(ctx.lock, eventBlock, ctx.tauMaturity, ctx.tauUnlock);
	if (amountRao > rolled.lockedRao) {
		throw new Error(
			`Simulated unlock ${Number(amountRao) / 1e9} α exceeds locked_mass ${Number(rolled.lockedRao) / 1e9} α at block ${eventBlock}`,
		);
	}
	const TWO_64 = 1n << 64n;
	const newLockedMass = rolled.lockedRao - amountRao;
	const newUnlockedMass = rolled.unlockedRao + amountRao;
	// Runtime does `conviction.saturating_sub(U64F64::from_num(amount))` —
	// keep that math in raw bits so a partial unlock loses exactly `amount`
	// of conviction, not a proportional fraction.
	const rolledBits = BigInt(Math.floor(rolled.convictionRao * Math.pow(2, 64)));
	const amountBits = amountRao * TWO_64;
	const newConvictionBits = rolledBits > amountBits ? rolledBits - amountBits : 0n;

	return {
		...ctx,
		lock: {
			...ctx.lock,
			lockedMass: newLockedMass,
			unlockedMass: newUnlockedMass,
			convictionBits: newConvictionBits,
			lastUpdate: eventBlock,
		},
	};
}

// Backwards-compatible alias — same behaviour, fires at head.
export function simulateUnlockAtHead(ctx: LockContext, amountRao: bigint): LockContext {
	return simulateUnlockAt(ctx, amountRao, ctx.headBlock);
}

// --- projection + history ---------------------------------------------------

// Produce an evenly-spaced series starting at `headBlock` and projecting
// forward `days` days, assuming no further user actions. Total alpha is held
// constant at the head value (it can only change via stake/unstake events,
// which projection by definition doesn't predict).
//
// If `event` is set, samples at block < event.atBlock use the original
// context; samples at block >= event.atBlock use the post-unlock state
// (computed by simulateUnlockAt). A duplicate pair of samples is inserted at
// the event block (pre + post) so the chart renders a vertical step at the
// unlock instead of a misleading interpolated ramp.
export function projectForward(
	ctx: LockContext,
	days: number,
	samplesPerDay: number,
	event?: UnlockEvent,
): LockSample[] {
	const totalSamples = Math.max(2, Math.round(days * samplesPerDay));
	const totalBlocks = Math.round((days * 24 * 3600 * 1000) / ctx.blockTimeMs);
	const blockStep = Math.max(1, Math.round(totalBlocks / (totalSamples - 1)));

	const postCtx = event ? simulateUnlockAt(ctx, event.amountRao, event.atBlock) : null;
	const eventBlock = event && postCtx ? postCtx.lock!.lastUpdate : null;

	const out: LockSample[] = [];
	let stepInserted = false;
	for (let i = 0; i < totalSamples; i++) {
		const block = ctx.headBlock + i * blockStep;
		const tDays = ((block - ctx.headBlock) * ctx.blockTimeMs) / 86_400_000;
		// Just before crossing the event boundary, drop in a pair of samples
		// at the event block — one with the pre-unlock context, one with the
		// post-unlock context — so the chart shows a clean vertical step.
		if (
			eventBlock !== null &&
			postCtx &&
			!stepInserted &&
			block >= eventBlock &&
			eventBlock >= ctx.headBlock
		) {
			const tEvent = ((eventBlock - ctx.headBlock) * ctx.blockTimeMs) / 86_400_000;
			out.push(sampleAt(ctx, eventBlock, tEvent, ctx.totalAlphaOnSubnetRao));
			out.push(sampleAt(postCtx, eventBlock, tEvent, ctx.totalAlphaOnSubnetRao));
			stepInserted = true;
		}
		const useCtx = eventBlock !== null && block >= eventBlock ? postCtx! : ctx;
		out.push(sampleAt(useCtx, block, tDays, ctx.totalAlphaOnSubnetRao));
	}
	return out;
}

// Compose one sample given a (block, tDays). Uses the *current* lock snapshot
// for projection; the caller passes a per-sample totalAlpha for history mode.
function sampleAt(
	ctx: LockContext,
	block: number,
	tDays: number,
	totalAlphaRao: bigint,
): LockSample {
	if (!ctx.lock) {
		const totalAlpha = Number(totalAlphaRao) / Number(TAO_BASE);
		return {
			block,
			tDays,
			locked: 0,
			unlocked: 0,
			conviction: 0,
			available: totalAlpha,
		};
	}
	const { lockedRao, unlockedRao, convictionRao } = rollForward(
		ctx.lock,
		block,
		ctx.tauMaturity,
		ctx.tauUnlock,
	);
	// available_stake() = total − locked − unlocked, clamped at 0.
	const availableRao =
		totalAlphaRao > lockedRao + unlockedRao ? totalAlphaRao - lockedRao - unlockedRao : 0n;
	return {
		block,
		tDays,
		locked: Number(lockedRao) / Number(TAO_BASE),
		unlocked: Number(unlockedRao) / Number(TAO_BASE),
		conviction: convictionRao / Number(TAO_BASE),
		available: Number(availableRao) / Number(TAO_BASE),
	};
}

export type StatusFn = (msg: string, done?: number, total?: number) => void;

// History mode: read LockState + total-alpha at each past sample block.
// Slower than projection (1 + N hotkeys storage reads per sample) but reflects
// real lock/unlock actions that happened in the window.
export async function fetchHistory(
	api: ApiPromise,
	coldkey: string,
	netuid: number,
	suppliedHotkey: string | null,
	startBlock: number,
	endBlock: number,
	samplesPerDay: number,
	blockTimeMs: number,
	tauMaturity: number,
	tauUnlock: number,
	concurrency: number,
	onStatus: StatusFn,
): Promise<LockSample[]> {
	if (endBlock <= startBlock) throw new Error(`empty range: ${startBlock} ≥ ${endBlock}`);
	const blocksPerSample = Math.max(1, Math.round(86_400_000 / blockTimeMs / samplesPerDay));
	const sampleBlocks: number[] = [];
	for (let b = startBlock; b <= endBlock; b += blocksPerSample) sampleBlocks.push(b);
	if (sampleBlocks[sampleBlocks.length - 1] !== endBlock) sampleBlocks.push(endBlock);

	onStatus(`Resolving ${sampleBlocks.length} sample block hashes...`);
	const hashes = await withLimit(sampleBlocks, concurrency, async (b) =>
		(await api.rpc.chain.getBlockHash(b)).toHex(),
	);
	const apis = await withLimit(hashes, concurrency, async (h) => await api.at(h));

	onStatus(`Reading lock + total alpha at ${sampleBlocks.length} blocks...`);
	const out = new Array<LockSample>(sampleBlocks.length);
	let done = 0;
	await withLimit(sampleBlocks, concurrency, async (block, i) => {
		const apiAt = apis[i];
		const lock = suppliedHotkey
			? ((await readLockExact(apiAt, coldkey, netuid, suppliedHotkey)) ??
				(await readLockEntry(apiAt, coldkey, netuid)))
			: await readLockEntry(apiAt, coldkey, netuid);
		const totalAlphaRao = await readTotalAlphaOnSubnet(apiAt, coldkey, netuid, 4);
		const tDays = ((block - startBlock) * blockTimeMs) / 86_400_000;
		const ctx: LockContext = {
			tauMaturity,
			tauUnlock,
			blockTimeMs,
			headBlock: block,
			lock,
			totalAlphaOnSubnetRao: totalAlphaRao,
		};
		out[i] = sampleAt(ctx, block, tDays, totalAlphaRao);
		done++;
		onStatus(`sampling`, done, sampleBlocks.length);
	});
	return out;
}
