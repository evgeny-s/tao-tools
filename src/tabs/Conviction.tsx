import { ApiPromise, WsProvider } from "@polkadot/api";
import {
	CategoryScale,
	Chart as ChartJS,
	Filler,
	Legend,
	LinearScale,
	LineController,
	LineElement,
	PointElement,
	Tooltip,
} from "chart.js";
import { useState } from "react";
import { Line } from "react-chartjs-2";
import StatusLog from "../components/StatusLog";
import type { StatusUpdate } from "../lib/fetcher";
import {
	type LockContext,
	type LockSample,
	type UnlockEvent,
	fetchHistory,
	loadLockContext,
	projectForward,
} from "../lib/conviction";
import { isLikelySs58, isValidWsUrl, localDateInput, parseBlockNumber } from "../lib/utils";

ChartJS.register(
	CategoryScale,
	LinearScale,
	PointElement,
	LineElement,
	LineController,
	Filler,
	Legend,
	Tooltip,
);

type Mode = "projection" | "history";
type RangeMode = "block" | "date";

type ResultPayload = {
	ctx: LockContext;
	samples: LockSample[];
	mode: Mode;
	suppliedHotkey: string | null;
};

export default function Conviction({ rpc }: { rpc: string }) {
	const [coldkey, setColdkey] = useState("");
	const [hotkey, setHotkey] = useState("");
	const [netuid, setNetuid] = useState(1);
	const [mode, setMode] = useState<Mode>("projection");
	const [projectionDays, setProjectionDays] = useState(180);
	const [samplesPerDay, setSamplesPerDay] = useState(10);
	const [concurrency, setConcurrency] = useState(10);
	// What-if: simulate an unlock_stake(amount) at some block during the
	// projection window. "" or 0 = no simulation. `simulatedUnlockDay` is days
	// after head (0 = at head, 30 = 30 days into the future).
	const [simulatedUnlockAlpha, setSimulatedUnlockAlpha] = useState("");
	const [simulatedUnlockDay, setSimulatedUnlockDay] = useState("0");

	const [fromMode, setFromMode] = useState<RangeMode>("date");
	const [toMode, setToMode] = useState<RangeMode>("date");
	const [fromValue, setFromValue] = useState(() => {
		const d = new Date();
		d.setDate(d.getDate() - 90);
		return localDateInput(d);
	});
	const [toValue, setToValue] = useState(() => localDateInput(new Date()));

	const [loading, setLoading] = useState(false);
	const [log, setLog] = useState<StatusUpdate[]>([]);
	const [result, setResult] = useState<ResultPayload | null>(null);

	function append(u: StatusUpdate) {
		// Coalesce repeated progress lines like MyStake does — keeps the log
		// from exploding during a many-block history fetch.
		setLog((prev) => {
			if (u.kind === "progress" && prev.length > 0) {
				const tail = prev[prev.length - 1];
				if (tail.kind === "progress" && tail.message === u.message) {
					return [...prev.slice(0, -1), u];
				}
			}
			return [...prev, u];
		});
	}

	async function onSubmit(e: React.FormEvent) {
		e.preventDefault();
		setResult(null);
		setLog([]);
		setLoading(true);
		try {
			if (!isValidWsUrl(rpc)) throw new Error("RPC must be a ws:// or wss:// URL");
			if (!isLikelySs58(coldkey)) throw new Error("Coldkey doesn't look like a valid SS58 address");
			const hk = hotkey.trim();
			if (hk && !isLikelySs58(hk)) throw new Error("Hotkey doesn't look like a valid SS58 address");
			const suppliedHk = hk || null;

			append({ kind: "info", message: `Connecting to ${rpc}...` });
			const api = await ApiPromise.create({ provider: new WsProvider(rpc) });
			try {
				append({ kind: "info", message: "Reading chain constants + current lock state..." });
				const ctx = await loadLockContext(api, coldkey.trim(), netuid, suppliedHk, concurrency);

				append({
					kind: "info",
					message: `τ_maturity=${ctx.tauMaturity} blocks, τ_unlock=${ctx.tauUnlock} blocks, block_time=${ctx.blockTimeMs}ms, head=${ctx.headBlock}`,
				});
				if (ctx.lock) {
					append({
						kind: "info",
						message: `Lock found → hotkey ${shortHk(ctx.lock.hotkey)}, locked_mass=${(Number(ctx.lock.lockedMass) / 1e9).toFixed(4)} α, unlocked_mass=${(Number(ctx.lock.unlockedMass) / 1e9).toFixed(4)} α, last_update=${ctx.lock.lastUpdate}`,
					});
					if (suppliedHk && suppliedHk !== ctx.lock.hotkey) {
						append({
							kind: "error",
							message: `Warning: you entered hotkey ${shortHk(suppliedHk)}, but the actual lock targets ${shortHk(ctx.lock.hotkey)}. Showing data for the actual lock.`,
						});
					}
				} else {
					append({
						kind: "info",
						message: `No active lock for this coldkey on netuid ${netuid}.`,
					});
				}

				let samples: LockSample[];
				if (mode === "projection") {
					const simAlpha = parseFloat(simulatedUnlockAlpha);
					const simDay = parseFloat(simulatedUnlockDay);
					let event: UnlockEvent | undefined;
					if (!isNaN(simAlpha) && simAlpha > 0) {
						const amountRao = BigInt(Math.floor(simAlpha * 1e9));
						const dayOffset = isNaN(simDay) || simDay < 0 ? 0 : simDay;
						const blockOffset = Math.round((dayOffset * 86_400_000) / ctx.blockTimeMs);
						event = { atBlock: ctx.headBlock + blockOffset, amountRao };
						append({
							kind: "info",
							message: `Simulating unlock_stake(${simAlpha} α) on day ${dayOffset.toFixed(2)} (block ${event.atBlock}).`,
						});
					}
					append({
						kind: "info",
						message: `Projecting forward ${projectionDays} days @ ${samplesPerDay} samples/day...`,
					});
					samples = projectForward(ctx, projectionDays, samplesPerDay, event);
				} else {
					const startBlock = await resolveBound(api, fromMode, fromValue, ctx);
					const endBlock = await resolveBound(api, toMode, toValue, ctx);
					if (startBlock >= endBlock) {
						throw new Error(`Invalid range: start ${startBlock} ≥ end ${endBlock}`);
					}
					append({
						kind: "info",
						message: `History mode: blocks ${startBlock} → ${endBlock} @ ${samplesPerDay}/day`,
					});
					samples = await fetchHistory(
						api,
						coldkey.trim(),
						netuid,
						suppliedHk,
						startBlock,
						endBlock,
						samplesPerDay,
						ctx.blockTimeMs,
						ctx.tauMaturity,
						ctx.tauUnlock,
						concurrency,
						(msg, done, total) =>
							append(
								done != null && total != null
									? { kind: "progress", message: msg, done, total }
									: { kind: "info", message: msg },
							),
					);
				}

				setResult({ ctx, samples, mode, suppliedHotkey: suppliedHk });
				append({ kind: "done", message: `Done. ${samples.length} samples.` });
			} finally {
				try {
					await api.disconnect();
				} catch {}
			}
		} catch (e: any) {
			console.error(e);
			append({ kind: "error", message: e?.message || String(e) });
		} finally {
			setLoading(false);
		}
	}

	return (
		<div>
			<form className="form" onSubmit={onSubmit}>
				<div className="row span-2">
					<label>Coldkey</label>
					<input
						value={coldkey}
						onChange={(e) => setColdkey(e.target.value)}
						placeholder="5Gb6x..."
						disabled={loading}
					/>
				</div>
				<div className="row span-2">
					<label>Hotkey (optional — auto-detected if blank)</label>
					<input
						value={hotkey}
						onChange={(e) => setHotkey(e.target.value)}
						placeholder="5F... (leave empty to use whichever hotkey is currently locked)"
						disabled={loading}
					/>
				</div>
				<div className="row">
					<label>Netuid</label>
					<input
						type="number"
						min={0}
						value={netuid}
						onChange={(e) => setNetuid(parseInt(e.target.value) || 0)}
						disabled={loading}
					/>
				</div>
				<div className="row">
					<label>Mode</label>
					<select value={mode} onChange={(e) => setMode(e.target.value as Mode)} disabled={loading}>
						<option value="projection">Projection (forward from head)</option>
						<option value="history">History (replay past blocks)</option>
					</select>
				</div>
				{mode === "projection" ? (
					<>
						<div className="row">
							<label>Days forward</label>
							<input
								type="number"
								min={1}
								max={3650}
								value={projectionDays}
								onChange={(e) => setProjectionDays(parseInt(e.target.value) || 180)}
								disabled={loading}
							/>
						</div>
						<div className="row">
							<label>Samples per day</label>
							<input
								type="number"
								min={1}
								max={100}
								value={samplesPerDay}
								onChange={(e) => setSamplesPerDay(parseInt(e.target.value) || 10)}
								disabled={loading}
							/>
						</div>
						<div className="row">
							<label>Simulate unlock — amount (α)</label>
							<input
								type="number"
								min={0}
								step="any"
								placeholder="e.g. 200 — blank = no simulation"
								value={simulatedUnlockAlpha}
								onChange={(e) => setSimulatedUnlockAlpha(e.target.value)}
								disabled={loading}
							/>
						</div>
						<div className="row">
							<label>...on day N after head (0 = at head)</label>
							<input
								type="number"
								min={0}
								step="any"
								value={simulatedUnlockDay}
								onChange={(e) => setSimulatedUnlockDay(e.target.value)}
								disabled={loading || !simulatedUnlockAlpha}
							/>
						</div>
					</>
				) : (
					<>
						<div className="row">
							<label>From</label>
							<div className="input-row">
								<select
									value={fromMode}
									onChange={(e) => setFromMode(e.target.value as RangeMode)}
									disabled={loading}
								>
									<option value="date">date</option>
									<option value="block">block</option>
								</select>
								<input
									type={fromMode === "date" ? "date" : "number"}
									value={fromValue}
									onChange={(e) => setFromValue(e.target.value)}
									disabled={loading}
								/>
							</div>
						</div>
						<div className="row">
							<label>To</label>
							<div className="input-row">
								<select
									value={toMode}
									onChange={(e) => setToMode(e.target.value as RangeMode)}
									disabled={loading}
								>
									<option value="date">date</option>
									<option value="block">block</option>
								</select>
								<input
									type={toMode === "date" ? "date" : "number"}
									value={toValue}
									onChange={(e) => setToValue(e.target.value)}
									disabled={loading}
								/>
							</div>
						</div>
						<div className="row">
							<label>Samples per day</label>
							<input
								type="number"
								min={1}
								max={100}
								value={samplesPerDay}
								onChange={(e) => setSamplesPerDay(parseInt(e.target.value) || 10)}
								disabled={loading}
							/>
						</div>
						<div className="row">
							<label>Concurrency</label>
							<input
								type="number"
								min={1}
								max={200}
								value={concurrency}
								onChange={(e) => setConcurrency(parseInt(e.target.value) || 10)}
								disabled={loading}
							/>
						</div>
					</>
				)}
				<button type="submit" className="submit" disabled={loading || !coldkey.trim()}>
					{loading ? (
						<>
							<span className="spinner" />
							Fetching...
						</>
					) : (
						"Fetch"
					)}
				</button>
			</form>

			{log.length > 0 && <StatusLog entries={log} />}

			{result && <ConvictionChart payload={result} />}
		</div>
	);
}

function ConvictionChart({ payload }: { payload: ResultPayload }) {
	const { ctx, samples, mode } = payload;
	const labels = samples.map((s) => s.tDays.toFixed(1));

	// Three lines that live inside [0, locked_mass] go on the left axis;
	// `available` (typically total stake minus the lock) goes on its own right
	// axis so a big stake vs. small lock doesn't squash the maturity curves
	// into a flat line at the bottom.
	const data = {
		labels,
		datasets: [
			{
				label: "Locked",
				data: samples.map((s) => s.locked),
				borderColor: "#60a5fa",
				backgroundColor: "#60a5fa22",
				tension: 0,
				pointRadius: 0,
				borderWidth: 2,
				yAxisID: "yLeft",
			},
			{
				label: "Unlocked (quarantine)",
				data: samples.map((s) => s.unlocked),
				borderColor: "#fb923c",
				backgroundColor: "#fb923c22",
				tension: 0.2,
				pointRadius: 0,
				borderWidth: 2,
				yAxisID: "yLeft",
			},
			{
				label: "Conviction",
				data: samples.map((s) => s.conviction),
				borderColor: "#4ade80",
				backgroundColor: "#4ade8022",
				tension: 0.2,
				pointRadius: 0,
				borderWidth: 2,
				yAxisID: "yLeft",
			},
			{
				label: "Available (right axis)",
				data: samples.map((s) => s.available),
				borderColor: "#a78bfa",
				backgroundColor: "#a78bfa22",
				tension: 0.2,
				pointRadius: 0,
				borderWidth: 2,
				borderDash: [4, 3],
				yAxisID: "yRight",
			},
		],
	};

	const options: any = {
		responsive: true,
		maintainAspectRatio: false,
		interaction: { mode: "index", intersect: false },
		plugins: {
			legend: { labels: { color: "#aaa" } },
			tooltip: {
				callbacks: {
					title: (items: any[]) =>
						`day ${items[0].label} (block ${samples[items[0].dataIndex].block})`,
					label: (item: any) => `${item.dataset.label}: ${item.parsed.y.toFixed(6)} α`,
				},
			},
		},
		scales: {
			x: {
				grid: { color: "#222" },
				ticks: { color: "#aaa", maxTicksLimit: 10 },
				title: { display: true, text: "days from start", color: "#888" },
			},
			yLeft: {
				type: "linear",
				position: "left",
				grid: { color: "#222" },
				ticks: { color: "#aaa" },
				title: { display: true, text: "α (lock-bounded)", color: "#888" },
				beginAtZero: true,
			},
			yRight: {
				type: "linear",
				position: "right",
				grid: { drawOnChartArea: false },
				ticks: { color: "#a78bfa" },
				title: { display: true, text: "α (available)", color: "#a78bfa" },
				beginAtZero: true,
			},
		},
	};

	// τ in human-readable units using the actual chain block time — for
	// fast-runtime testing this will show different values than mainnet.
	const tauMaturityDays = (ctx.tauMaturity * ctx.blockTimeMs) / 86_400_000;
	const tauUnlockDays = (ctx.tauUnlock * ctx.blockTimeMs) / 86_400_000;

	return (
		<>
			<div className="wrap" style={{ fontSize: 12, fontFamily: "ui-monospace, monospace" }}>
				<div style={{ color: "#aaa" }}>
					<strong style={{ color: "#fff" }}>τ_maturity</strong> = {ctx.tauMaturity} blocks (
					{tauMaturityDays.toFixed(2)} days @ {ctx.blockTimeMs}ms/block)
					<span style={{ color: "#555" }}> · 1τ ≈ 63.2%, 3τ ≈ 95% of locked</span>
				</div>
				<div style={{ color: "#aaa", marginTop: 4 }}>
					<strong style={{ color: "#fff" }}>τ_unlock</strong> = {ctx.tauUnlock} blocks (
					{tauUnlockDays.toFixed(2)} days @ {ctx.blockTimeMs}ms/block)
					<span style={{ color: "#555" }}> · 1τ ≈ 36.8% of unlocked_mass remaining</span>
				</div>
				{ctx.lock ? (
					<div style={{ color: "#aaa", marginTop: 4 }}>
						<strong style={{ color: "#fff" }}>Current lock</strong> targets{" "}
						<span style={{ color: "#fff" }}>{shortHk(ctx.lock.hotkey)}</span> · locked_mass{" "}
						{(Number(ctx.lock.lockedMass) / 1e9).toFixed(4)} α · unlocked_mass{" "}
						{(Number(ctx.lock.unlockedMass) / 1e9).toFixed(4)} α · last_update {ctx.lock.lastUpdate}
					</div>
				) : (
					<div style={{ color: "#aaa", marginTop: 4 }}>No active lock found.</div>
				)}
				<div style={{ color: "#555", marginTop: 4 }}>
					Mode: <strong>{mode}</strong> · total α on subnet at head:{" "}
					{(Number(ctx.totalAlphaOnSubnetRao) / 1e9).toFixed(4)} α
				</div>
			</div>
			<div className="wrap" style={{ height: 460 }}>
				<Line data={data} options={options} />
			</div>
		</>
	);
}

function shortHk(hk: string): string {
	if (!hk || hk.length < 12) return hk;
	return `${hk.slice(0, 6)}…${hk.slice(-4)}`;
}

async function resolveBound(
	api: ApiPromise,
	mode: RangeMode,
	value: string,
	ctx: LockContext,
): Promise<number> {
	if (mode === "block") return parseBlockNumber(value);
	const d = new Date(value);
	if (isNaN(d.getTime())) throw new Error(`Invalid date: "${value}"`);
	// Anchor on chain head's timestamp (not Date.now()) — on fast-runtime or
	// short test chains, wall clock can be hours ahead of the chain.
	const headHash = (await api.rpc.chain.getBlockHash(ctx.headBlock)).toHex();
	const apiAt = await api.at(headHash);
	const headTsMs = ((await apiAt.query.timestamp.now()) as any).toNumber();
	const diffBlocks = Math.floor((headTsMs - d.getTime()) / ctx.blockTimeMs);
	const b = ctx.headBlock - diffBlocks;
	return Math.max(1, Math.min(ctx.headBlock, b));
}
