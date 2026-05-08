import { useRef, useState } from "react";
import EmissionsTimeline from "../components/EmissionsTimeline";
import StatusLog from "../components/StatusLog";
import {
	type EmissionsResult,
	alphaAsNumber,
	fetchEmissionEvents,
} from "../lib/emissionsFetcher";
import type { FetchBound, StatusUpdate } from "../lib/fetcher";
import { isValidWsUrl, parseBlockNumber } from "../lib/utils";

type RangeMode = "block" | "date";

export default function MinerEmissions({ rpc }: { rpc: string }) {
	const [netuidStr, setNetuidStr] = useState(""); // empty = all
	const [fromMode, setFromMode] = useState<RangeMode>("date");
	const [toMode, setToMode] = useState<RangeMode>("date");
	// Default window: last 5 hours → now.
	const [fromValue, setFromValue] = useState(() => {
		const d = new Date();
		d.setHours(d.getHours() - 5);
		return d.toISOString().slice(0, 16); // yyyy-MM-ddTHH:mm
	});
	const [toValue, setToValue] = useState(() => new Date().toISOString().slice(0, 16));
	const [concurrency, setConcurrency] = useState(20);

	const [loading, setLoading] = useState(false);
	const [statusLog, setStatusLog] = useState<StatusUpdate[]>([]);
	const [result, setResult] = useState<EmissionsResult | null>(null);
	const lastProgress = useRef<string>("");

	function parseBound(mode: RangeMode, value: string): FetchBound {
		if (mode === "block") return parseBlockNumber(value);
		const d = new Date(value);
		if (isNaN(d.getTime())) throw new Error(`Invalid date: "${value}"`);
		return d;
	}

	function appendStatus(u: StatusUpdate) {
		setStatusLog((prev) => {
			if (u.kind === "progress") {
				const key = u.message;
				if (
					lastProgress.current === key &&
					prev.length > 0 &&
					prev[prev.length - 1].kind === "progress"
				) {
					const next = prev.slice(0, -1);
					next.push(u);
					return next;
				}
				lastProgress.current = key;
				return [...prev, u];
			}
			lastProgress.current = "";
			return [...prev, u];
		});
	}

	async function onSubmit(e: React.FormEvent) {
		e.preventDefault();
		setResult(null);
		setStatusLog([]);
		setLoading(true);
		try {
			if (!isValidWsUrl(rpc)) throw new Error(`RPC must be a ws:// or wss:// URL`);

			let netuidFilter: number | null = null;
			if (netuidStr.trim() !== "") {
				const n = Number(netuidStr.trim());
				if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n)
					throw new Error(`Invalid netuid: "${netuidStr}"`);
				netuidFilter = n;
			}

			const from = parseBound(fromMode, fromValue);
			const to = parseBound(toMode, toValue);
			const data = await fetchEmissionEvents(
				{ rpc, netuidFilter, from, to, concurrency },
				appendStatus,
			);
			setResult(data);
		} catch (e: any) {
			console.error(e);
			appendStatus({ kind: "error", message: e?.message || String(e) });
		} finally {
			setLoading(false);
		}
	}

	return (
		<div>
			<form className="form" onSubmit={onSubmit}>
				<div className="row span-2">
					<label>Netuid (optional — blank = all subnets)</label>
					<input
						value={netuidStr}
						onChange={(e) => setNetuidStr(e.target.value)}
						placeholder="e.g. 64"
						disabled={loading}
					/>
				</div>
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
							type={fromMode === "date" ? "datetime-local" : "number"}
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
							type={toMode === "date" ? "datetime-local" : "number"}
							value={toValue}
							onChange={(e) => setToValue(e.target.value)}
							disabled={loading}
						/>
					</div>
				</div>
				<div className="row">
					<label>Concurrency</label>
					<input
						type="number"
						min={1}
						max={200}
						value={concurrency}
						onChange={(e) => setConcurrency(parseInt(e.target.value) || 20)}
						disabled={loading}
					/>
				</div>
				<div className="row">
					<label>&nbsp;</label>
					<div style={{ fontSize: 11, color: "#666", lineHeight: 1.5 }}>
						Scans every block in the window for IncentiveAlphaEmittedToMiners events.
						<br />1 hour ≈ 300 blocks. Larger windows take proportionally longer.
					</div>
				</div>
				<button type="submit" className="submit" disabled={loading}>
					{loading ? (
						<>
							<span className="spinner" />
							Scanning...
						</>
					) : (
						"Fetch emissions"
					)}
				</button>
			</form>

			{statusLog.length > 0 && <StatusLog entries={statusLog} />}

			{result && (
				<>
					<div className="summary">
						<div className="row">
							<div>
								<span className="k">blocks:</span>
								<span className="v">
									{result.meta.startBlock} → {result.meta.endBlock} ({result.meta.blocksScanned})
								</span>
							</div>
							<div>
								<span className="k">subnets:</span>
								<span className="v">{result.netuids.length}</span>
							</div>
							<div>
								<span className="k">events:</span>
								<span className="v">{result.totalEvents}</span>
							</div>
							<div>
								<span className="k">total α emitted:</span>
								<span className="v">{alphaAsNumber(result.totalAlpha).toFixed(4)} α</span>
							</div>
						</div>
					</div>
					<h2>
						Miner incentive emissions per subnet — timeline of IncentiveAlphaEmittedToMiners events
					</h2>
					<div className="note">
						Each bar = one end-of-epoch event (left axis, α emitted). Yellow line = blocks
						since previous event for the same subnet (right axis) — anomalies (skipped epochs,
						tempo changes) show up as line spikes. Hover a bar to see per-miner shares; bottom
						list = top miners by total α received in the window.
					</div>
					<EmissionsTimeline result={result} />
				</>
			)}
		</div>
	);
}
