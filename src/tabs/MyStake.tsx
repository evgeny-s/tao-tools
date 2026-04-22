import { useState, useRef } from "react";
import {
	DEFAULT_RPC,
	estimateBlockForDate,
	fetchStakeData,
	getHeadBlock,
	type FetchResult,
	type StatusUpdate,
} from "../lib/fetcher";
import BalanceGrid from "../components/BalanceGrid";
import StatusLog from "../components/StatusLog";
import Summary from "../components/Summary";

type RangeMode = "block" | "date";

export default function MyStake() {
	const [rpc, setRpc] = useState(DEFAULT_RPC);
	const [coldkey, setColdkey] = useState("5Gb6x9SZQULGmFdFnx62GFH24WdcUQseo9pxiWpFwBPWqvyh");
	const [fromMode, setFromMode] = useState<RangeMode>("date");
	const [toMode, setToMode] = useState<RangeMode>("date");
	// defaults: last 30 days → now
	const [fromValue, setFromValue] = useState(() => {
		const d = new Date();
		d.setDate(d.getDate() - 30);
		return d.toISOString().slice(0, 10);
	});
	const [toValue, setToValue] = useState(() => new Date().toISOString().slice(0, 10));
	const [samplesPerDay, setSamplesPerDay] = useState(10);
	const [concurrency, setConcurrency] = useState(10);

	const [loading, setLoading] = useState(false);
	const [statusLog, setStatusLog] = useState<StatusUpdate[]>([]);
	const [result, setResult] = useState<FetchResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const lastProgress = useRef<string>("");

	async function resolveBlock(mode: RangeMode, value: string): Promise<number> {
		if (mode === "block") return parseInt(value);
		const d = new Date(value);
		if (isNaN(d.getTime())) throw new Error(`Invalid date: ${value}`);
		return await estimateBlockForDate(rpc, d);
	}

	function appendStatus(u: StatusUpdate) {
		setStatusLog((prev) => {
			// Collapse repeated "progress" lines into a single updating entry.
			if (u.kind === "progress") {
				const key = `${u.message}`;
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
		setError(null);
		setResult(null);
		setStatusLog([]);
		setLoading(true);
		try {
			appendStatus({ kind: "info", message: "Resolving block range..." });
			let startBlock = await resolveBlock(fromMode, fromValue);
			let endBlock =
				toMode === "date" && toValue === new Date().toISOString().slice(0, 10)
					? await getHeadBlock(rpc)
					: await resolveBlock(toMode, toValue);
			if (startBlock >= endBlock)
				throw new Error(`Invalid range: start ${startBlock} ≥ end ${endBlock}`);
			appendStatus({ kind: "info", message: `Range: block ${startBlock} → ${endBlock}` });
			const data = await fetchStakeData(
				{ rpc, coldkey: coldkey.trim(), startBlock, endBlock, samplesPerDay, concurrency },
				appendStatus,
			);
			setResult(data);
		} catch (e: any) {
			console.error(e);
			const msg = e?.message || String(e);
			setError(msg);
			appendStatus({ kind: "error", message: msg });
		} finally {
			setLoading(false);
		}
	}

	return (
		<div>
			<form className="form" onSubmit={onSubmit}>
				<div className="row span-2">
					<label>RPC endpoint</label>
					<input
						value={rpc}
						onChange={(e) => setRpc(e.target.value)}
						placeholder={DEFAULT_RPC}
						disabled={loading}
					/>
				</div>
				<div className="row span-2">
					<label>Coldkey</label>
					<input
						value={coldkey}
						onChange={(e) => setColdkey(e.target.value)}
						placeholder="5Gb6x..."
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
						max={30}
						value={concurrency}
						onChange={(e) => setConcurrency(parseInt(e.target.value) || 10)}
						disabled={loading}
					/>
				</div>
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

			{(statusLog.length > 0 || error) && <StatusLog entries={statusLog} />}

			{result && (
				<>
					<Summary result={result} />
					<h2>User balance (α) per position — own Y scale, stake-op markers overlaid</h2>
					<div className="note">
						Green dashed line = StakeAdded/Moved(in); red dashed line = StakeRemoved/Moved(out).
						Click block number below each chart to open polkadot.js explorer.
					</div>
					<BalanceGrid result={result} />
				</>
			)}
		</div>
	);
}
