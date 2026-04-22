import { useEffect, useRef } from "react";
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
import { Line } from "react-chartjs-2";
import type { FetchResult, PositionData, StakeOp } from "../lib/fetcher";

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

const PALETTE = [
	"#4ade80",
	"#60a5fa",
	"#f472b6",
	"#fbbf24",
	"#a78bfa",
	"#22d3ee",
	"#f87171",
	"#34d399",
	"#c084fc",
	"#fb923c",
	"#38bdf8",
	"#facc15",
];

// Chart.js plugin: draw vertical lines + triangle markers at stake-op x-indices.
const stakeOpPlugin = {
	id: "stakeOps",
	afterDatasetsDraw(chart: any, _args: any, opts: any) {
		const ops: StakeOp[] = opts?.ops || [];
		const { ctx, chartArea, scales } = chart;
		if (!ops.length) return;
		ctx.save();
		for (const op of ops) {
			const x = scales.x.getPixelForValue(op.xIndex);
			if (x < chartArea.left || x > chartArea.right) continue;
			const isAdd = op.eventType.includes("Added") || op.eventType.includes("(in)");
			ctx.strokeStyle = isAdd ? "rgba(74, 222, 128, 0.8)" : "rgba(248, 113, 113, 0.8)";
			ctx.lineWidth = 2;
			ctx.setLineDash([4, 3]);
			ctx.beginPath();
			ctx.moveTo(x, chartArea.top);
			ctx.lineTo(x, chartArea.bottom);
			ctx.stroke();
			ctx.setLineDash([]);
			ctx.fillStyle = isAdd ? "#4ade80" : "#f87171";
			ctx.beginPath();
			ctx.moveTo(x - 4, chartArea.top);
			ctx.lineTo(x + 4, chartArea.top);
			ctx.lineTo(x, chartArea.top + 7);
			ctx.closePath();
			ctx.fill();
		}
		ctx.restore();
	},
};
ChartJS.register(stakeOpPlugin);

function shortHk(hk: string): string {
	return `${hk.slice(0, 6)}…${hk.slice(-4)}`;
}

export default function BalanceGrid({ result }: { result: FetchResult }) {
	return (
		<div className="grid">
			{result.positions.map((p, i) => (
				<PositionCard
					key={`${p.hotkey}|${p.netuid}`}
					position={p}
					labels={result.labels}
					blocks={result.blocks}
					colorIdx={i}
				/>
			))}
		</div>
	);
}

function PositionCard({
	position,
	labels,
	blocks,
	colorIdx,
}: {
	position: PositionData;
	labels: string[];
	blocks: number[];
	colorIdx: number;
}) {
	const color = PALETTE[colorIdx % PALETTE.length];
	const vals = position.samples.map((s) => Number(s.balance) / 1e9);
	const first = vals[0];
	const last = vals[vals.length - 1];
	const mn = Math.min(...vals);
	const mx = Math.max(...vals);

	const data = {
		labels,
		datasets: [
			{
				label: "balance (α)",
				data: vals,
				borderColor: color,
				backgroundColor: color + "33",
				tension: 0.2,
				pointRadius: 2,
				borderWidth: 2,
				fill: true,
			},
		],
	};

	const options: any = {
		responsive: true,
		maintainAspectRatio: true,
		interaction: { mode: "index", intersect: false },
		plugins: {
			legend: { display: false },
			stakeOps: { ops: position.stakeOps },
			tooltip: {
				callbacks: {
					title: (items: any[]) => `${items[0].label} (block ${blocks[items[0].dataIndex]})`,
					label: (ctx: any) => `${ctx.parsed.y.toFixed(6)} α`,
				},
			},
		},
		scales: {
			x: { grid: { color: "#222" }, ticks: { color: "#aaa", maxTicksLimit: 8 } },
			y: { grid: { color: "#222" }, ticks: { color: "#aaa" } },
		},
	};

	return (
		<div className="cell">
			<h3>
				SN{position.netuid} · {position.identityName || "—"} · {shortHk(position.hotkey)}
			</h3>
			<div className="meta">
				start {first.toFixed(4)} α → end {last.toFixed(4)} α · Δ {last - first >= 0 ? "+" : ""}
				{(last - first).toFixed(4)} α · min {mn.toFixed(4)} · max {mx.toFixed(4)}
				{position.poolApyPct !== null && (
					<>
						{" "}
						· pool APY {position.poolApyPct.toFixed(2)}% · realized div{" "}
						{position.realizedDividend.toFixed(4)} α
					</>
				)}
			</div>
			<Line data={data} options={options} height={110} />
			<div className="ops">
				{position.stakeOps.length === 0 ? (
					<span style={{ color: "#555" }}>no stake operations detected</span>
				) : (
					<>
						<span style={{ color: "#888" }}>{position.stakeOps.length} stake op(s):</span>
						{position.stakeOps.map((op, j) => {
							const isAdd = op.eventType.includes("Added") || op.eventType.includes("(in)");
							const c = isAdd ? "#4ade80" : "#f87171";
							return (
								<div className="op" key={j}>
									<span style={{ color: c, fontWeight: 600 }}>●</span> block{" "}
									<a href={op.polkadotJsLink} target="_blank" rel="noopener noreferrer">
										{op.block}
									</a>{" "}
									· <span style={{ color: c }}>{op.eventType}</span>
									{op.taoHuman && ` · ${op.taoHuman} TAO`}
									{op.alphaHuman && ` · ${op.alphaHuman} α`}
									{" · Δ "}
									{op.deltaAlphaHuman} α
								</div>
							);
						})}
					</>
				)}
			</div>
		</div>
	);
}
