import {
	CategoryScale,
	Chart as ChartJS,
	Filler,
	Legend,
	LineController,
	LineElement,
	LinearScale,
	PointElement,
	Tooltip,
} from "chart.js";
import { Line } from "react-chartjs-2";
import { type BlockWeightResult, fmtRefTime } from "../lib/blockWeightFetcher";
import { localDateTimeInput } from "../lib/utils";

ChartJS.register(
	LineController,
	LineElement,
	CategoryScale,
	LinearScale,
	PointElement,
	Filler,
	Legend,
	Tooltip,
);

function fmtTime(ms: number): string {
	return localDateTimeInput(new Date(ms)).replace("T", " ");
}

function shortName(name: string): string {
	// "subtensorModule.add_stake" → "add_stake" keeps the table readable; the
	// full pallet.call is kept in the title attribute for hover.
	const dot = name.indexOf(".");
	return dot >= 0 ? name.slice(dot + 1) : name;
}

export default function BlockWeightChart({ result }: { result: BlockWeightResult }) {
	const { samples, callAggs, heaviest, meta } = result;
	if (samples.length === 0) {
		return <div className="note">No blocks in this window.</div>;
	}

	const labels = samples.map((s) => s.block);

	const data = {
		labels,
		datasets: [
			{
				label: "Block weight (% of max_block refTime)",
				data: samples.map((s) => s.utilPct),
				borderColor: "#60a5fa",
				backgroundColor: "rgba(96,165,250,0.15)",
				borderWidth: 1.5,
				pointRadius: 0,
				fill: true,
				tension: 0.1,
			},
			{
				label: "Normal class (% of normal cap)",
				data: samples.map((s) => s.normalPct),
				borderColor: "#f472b6",
				backgroundColor: "rgba(244,114,182,0)",
				borderWidth: 1,
				pointRadius: 0,
				fill: false,
				tension: 0.1,
			},
		],
	};

	const options: any = {
		responsive: true,
		maintainAspectRatio: false,
		interaction: { mode: "index", intersect: false },
		scales: {
			x: {
				ticks: {
					maxTicksLimit: 12,
					color: "#888",
					callback(_v: any, i: number) {
						return samples[i] ? samples[i].block : "";
					},
				},
				grid: { color: "rgba(255,255,255,0.04)" },
			},
			y: {
				title: { display: true, text: "% of limit", color: "#888" },
				ticks: { color: "#888" },
				grid: { color: "rgba(255,255,255,0.06)" },
				beginAtZero: true,
			},
		},
		plugins: {
			legend: { labels: { color: "#ccc", boxWidth: 12 } },
			tooltip: {
				callbacks: {
					title(items: any[]) {
						const s = samples[items[0].dataIndex];
						return `block ${s.block} · ${fmtTime(s.timestampMs)}`;
					},
					afterBody(items: any[]) {
						const s = samples[items[0].dataIndex];
						const lines = [
							`total refTime: ${fmtRefTime(s.totalRefTime)}`,
							`  normal: ${fmtRefTime(s.normal.refTime)}`,
							`  operational: ${fmtRefTime(s.operational.refTime)}`,
							`  mandatory: ${fmtRefTime(s.mandatory.refTime)}`,
						];
						if (meta.attribute) {
							lines.push(`extrinsics: ${s.numExtrinsics}`);
							if (s.topCall)
								lines.push(`heaviest: ${s.topCall.name} (${fmtRefTime(s.topCall.refTime)})`);
						}
						return lines;
					},
				},
			},
		},
	};

	return (
		<div>
			<div className="summary">
				<div className="row">
					<div>
						<span className="k">blocks:</span>
						<span className="v">
							{meta.startBlock} → {meta.endBlock} ({meta.blocksScanned})
						</span>
					</div>
					<div>
						<span className="k">avg util:</span>
						<span className="v">{result.avgUtilPct.toFixed(2)}%</span>
					</div>
					<div>
						<span className="k">peak util:</span>
						<span className="v">{result.maxUtilPct.toFixed(2)}%</span>
					</div>
					<div>
						<span className="k">max_block:</span>
						<span className="v">{fmtRefTime(meta.maxBlockRefTime)} refTime</span>
					</div>
				</div>
			</div>

			<h2>Block weight utilization over time</h2>
			<div className="note">
				Blue = total weight consumed by the block (all dispatch classes) as a share of the runtime's
				hard <code>max_block</code> refTime ceiling. Pink = the Normal class alone vs its{" "}
				<code>maxTotal</code> cap (75% of max_block on subtensor). <code>refTime</code> bundles raw
				compute and storage read/write cost (RocksDbWeight); <code>proof_size</code> is unbounded on
				this chain, so it is not a fullness metric. Hover a point for the per-class split and (if
				attribution is on) the heaviest extrinsic in that block.
			</div>
			<div style={{ height: 360 }}>
				<Line data={data} options={options} />
			</div>

			{meta.attribute && callAggs.length > 0 && (
				<>
					<h2>What pulls the weight — per call, summed over the window</h2>
					<div className="note">
						Actual (post-refund) weight billed per call type, aggregated across every extrinsic in
						the window. Share is of total extrinsic weight (excludes block/on_initialize base
						weight, which has no call to attribute it to).
					</div>
					<CallTable result={result} />

					<h2>Heaviest individual extrinsics</h2>
					<div className="note">Single extrinsics that consumed the most in one block.</div>
					<HeavyTable heaviest={heaviest} />
				</>
			)}
		</div>
	);
}

function CallTable({ result }: { result: BlockWeightResult }) {
	const max = result.callAggs[0]?.refTime ?? 1n;
	return (
		<table className="bw-table">
			<thead>
				<tr>
					<th>call</th>
					<th>count</th>
					<th>total refTime</th>
					<th>share</th>
					<th></th>
				</tr>
			</thead>
			<tbody>
				{result.callAggs.map((c) => (
					<tr key={c.name}>
						<td title={c.name}>{shortName(c.name)}</td>
						<td className="num">{c.count}</td>
						<td className="num">{fmtRefTime(c.refTime)}</td>
						<td className="num">{c.share.toFixed(1)}%</td>
						<td className="bar-cell">
							<span
								className="bar"
								style={{
									width: `${max > 0n ? Number((c.refTime * 100n) / max) : 0}%`,
								}}
							/>
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

function HeavyTable({ heaviest }: { heaviest: BlockWeightResult["heaviest"] }) {
	const explorer = (block: number) =>
		`https://polkadot.js.org/apps/?rpc=wss%3A%2F%2Fentrypoint-finney.opentensor.ai#/explorer/query/${block}`;
	return (
		<table className="bw-table">
			<thead>
				<tr>
					<th>block</th>
					<th>idx</th>
					<th>call</th>
					<th>refTime</th>
					<th>% of max_block</th>
				</tr>
			</thead>
			<tbody>
				{heaviest.map((h) => (
					<tr key={`${h.block}-${h.index}`}>
						<td>
							<a href={explorer(h.block)} target="_blank" rel="noreferrer">
								{h.block}
							</a>
						</td>
						<td className="num">{h.index}</td>
						<td title={h.name}>{shortName(h.name)}</td>
						<td className="num">{fmtRefTime(h.refTime)}</td>
						<td className="num">{h.pctOfMaxBlock.toFixed(2)}%</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}
