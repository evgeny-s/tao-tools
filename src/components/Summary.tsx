import type { FetchResult } from "../lib/fetcher";

export default function Summary({ result }: { result: FetchResult }) {
	const { meta, summary } = result;
	return (
		<div className="summary">
			<div className="row">
				<div>
					<span className="k">coldkey:</span>
					<span className="v">{meta.coldkey}</span>
				</div>
				<div>
					<span className="k">blocks:</span>
					<span className="v">
						{meta.startBlock} → {meta.endBlock}
					</span>
				</div>
				<div>
					<span className="k">samples:</span>
					<span className="v">
						{meta.totalSamples} ({meta.samplesPerDay}/day)
					</span>
				</div>
				<div>
					<span className="k">positions:</span>
					<span className="v">{summary.positions}</span>
				</div>
				<div>
					<span className="k">median pool APY:</span>
					<span className="v">{summary.medianPoolApyPct.toFixed(2)}%</span>
				</div>
				<div>
					<span className="k">total realized div:</span>
					<span className="v">{summary.totalRealizedDividend.toFixed(4)} α</span>
				</div>
				<div>
					<span className="k">total passive div (baseline):</span>
					<span className="v">{summary.totalPassiveDividend.toFixed(4)} α</span>
				</div>
			</div>
		</div>
	);
}
