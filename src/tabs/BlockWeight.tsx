import { useRef, useState } from "react";
import BlockWeightChart from "../components/BlockWeightChart";
import StatusLog from "../components/StatusLog";
import { type BlockWeightResult, fetchBlockWeights } from "../lib/blockWeightFetcher";
import type { FetchBound, StatusUpdate } from "../lib/fetcher";
import { isValidWsUrl, localDateTimeInput, parseBlockNumber } from "../lib/utils";

type RangeMode = "block" | "date";

export default function BlockWeight({ rpc }: { rpc: string }) {
	const [fromMode, setFromMode] = useState<RangeMode>("date");
	const [toMode, setToMode] = useState<RangeMode>("date");
	// Default window: last 1 hour → now (~300 blocks).
	const [fromValue, setFromValue] = useState(() => {
		const d = new Date();
		d.setHours(d.getHours() - 1);
		return localDateTimeInput(d);
	});
	const [toValue, setToValue] = useState(() => localDateTimeInput(new Date()));
	const [concurrency, setConcurrency] = useState(20);
	const [attribute, setAttribute] = useState(true);

	const [loading, setLoading] = useState(false);
	const [statusLog, setStatusLog] = useState<StatusUpdate[]>([]);
	const [result, setResult] = useState<BlockWeightResult | null>(null);
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
			const from = parseBound(fromMode, fromValue);
			const to = parseBound(toMode, toValue);
			const data = await fetchBlockWeights({ rpc, from, to, concurrency, attribute }, appendStatus);
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
					<label>Per-call attribution</label>
					<label className="input-row" style={{ alignItems: "center", gap: 8 }}>
						<input
							type="checkbox"
							checked={attribute}
							onChange={(e) => setAttribute(e.target.checked)}
							disabled={loading}
							style={{ width: "auto" }}
						/>
						<span style={{ fontSize: 12, color: "#888" }}>
							read each block body + events (slower)
						</span>
					</label>
				</div>
				<div className="row span-2">
					<label>&nbsp;</label>
					<div style={{ fontSize: 11, color: "#666", lineHeight: 1.5 }}>
						Reads System::BlockWeight per block for the utilization line. With attribution on, also
						pulls each block's extrinsics + events to break weight down per call.
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
						"Fetch block weights"
					)}
				</button>
			</form>

			{statusLog.length > 0 && <StatusLog entries={statusLog} />}

			{result && <BlockWeightChart result={result} />}
		</div>
	);
}
