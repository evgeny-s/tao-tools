import {
	BarController,
	BarElement,
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
import { Chart } from "react-chartjs-2";
import {
	type EmissionEvent,
	type EmissionsResult,
	type NetuidData,
	alphaAsNumber,
	formatAlpha,
} from "../lib/emissionsFetcher";
import { localDateTimeInput } from "../lib/utils";

ChartJS.register(
	BarController,
	BarElement,
	LineController,
	LineElement,
	CategoryScale,
	LinearScale,
	PointElement,
	Filler,
	Legend,
	Tooltip,
);

const GAP_LINE_COLOR = "#fbbf24";

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

function shortHk(hk: string): string {
	if (!hk) return "—";
	return `${hk.slice(0, 6)}…${hk.slice(-4)}`;
}

function fmtTime(ms: number): string {
	// Render in the viewer's local timezone — the inputs are picked in local
	// time, so the chart should display in the same frame.
	return localDateTimeInput(new Date(ms)).replace("T", " ");
}

export default function EmissionsTimeline({ result }: { result: EmissionsResult }) {
	if (result.netuids.length === 0) {
		return <div className="note">No IncentiveAlphaEmittedToMiners events in this window.</div>;
	}
	return (
		<div className="grid">
			{result.netuids.map((n, i) => (
				<NetuidCard key={n.netuid} data={n} colorIdx={i} />
			))}
		</div>
	);
}

function NetuidCard({ data, colorIdx }: { data: NetuidData; colorIdx: number }) {
	const color = PALETTE[colorIdx % PALETTE.length];
	const points = data.events.map((e) => ({
		x: e.timestampMs,
		y: alphaAsNumber(e.totalAlpha),
	}));

	// Per-event "blocks since previous event"; first event has no predecessor → null
	// (chart.js will skip the segment, which keeps the line visually correct).
	const gapPoints = data.events.map((e, i) => ({
		x: e.timestampMs,
		y: i === 0 ? null : e.block - data.events[i - 1].block,
	}));

	const gaps: number[] = [];
	for (let i = 1; i < data.events.length; i++) {
		gaps.push(data.events[i].block - data.events[i - 1].block);
	}
	const medianGap = gaps.length
		? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)]
		: null;

	const chartData = {
		datasets: [
			{
				type: "bar" as const,
				label: "α emitted",
				data: points,
				backgroundColor: color,
				borderColor: color,
				borderWidth: 1,
				barPercentage: 1.0,
				categoryPercentage: 1.0,
				// Render bars as narrow vertical lines for a "timeline" feel.
				barThickness: 4,
				maxBarThickness: 8,
				yAxisID: "y",
				order: 2,
			},
			{
				type: "line" as const,
				label: "blocks since prev",
				data: gapPoints,
				borderColor: GAP_LINE_COLOR,
				backgroundColor: GAP_LINE_COLOR,
				borderWidth: 1.25,
				pointRadius: 2,
				pointHoverRadius: 4,
				tension: 0,
				spanGaps: false,
				yAxisID: "y1",
				order: 1,
			},
		],
	};

	const eventsByX = new Map<number, EmissionEvent>();
	for (const e of data.events) eventsByX.set(e.timestampMs, e);

	const options: any = {
		responsive: true,
		maintainAspectRatio: true,
		interaction: { mode: "nearest", intersect: false, axis: "x" as const },
		plugins: {
			legend: {
				display: true,
				position: "top" as const,
				align: "end" as const,
				labels: {
					color: "#aaa",
					boxWidth: 10,
					boxHeight: 10,
					font: { size: 11 },
					filter: (item: any) => item.text !== undefined,
				},
			},
			tooltip: {
				backgroundColor: "#0b0e14",
				borderColor: "#222",
				borderWidth: 1,
				titleColor: "#e6e6e6",
				bodyColor: "#e6e6e6",
				bodyFont: { family: "ui-monospace, monospace", size: 11 },
				titleFont: { family: "ui-monospace, monospace", size: 11 },
				padding: 10,
				caretSize: 4,
				cornerRadius: 4,
				callbacks: {
					title: (items: any[]) => {
						const x = items[0]?.parsed?.x;
						const ev = eventsByX.get(x);
						if (!ev) return "";
						return `block ${ev.block} · ${fmtTime(ev.timestampMs)}`;
					},
					label: (ctx: any) => {
						// Tooltip is shared (mode: index) — the bar-dataset label is enough,
						// suppress per-line output for the gap-line dataset to avoid duplicates.
						if (ctx.dataset.type === "line") return null as any;
						const x = ctx.parsed.x;
						const ev = eventsByX.get(x);
						if (!ev) return "";
						const total = alphaAsNumber(ev.totalAlpha);
						const idx = data.events.findIndex((e) => e.timestampMs === x);
						const gap = idx > 0 ? ev.block - data.events[idx - 1].block : null;
						const lines = [`total: ${total.toFixed(6)} α  ·  ${ev.perMiner.length} miner(s)`];
						lines.push(gap !== null ? `gap from prev: ${gap} blocks` : `gap from prev: —`);
						lines.push("");
						const top = ev.perMiner.slice(0, 12);
						for (const m of top) {
							lines.push(
								`uid ${m.uid.toString().padStart(3)}  ${shortHk(m.hotkey)}  ${formatAlpha(m.alpha, 6)} α`,
							);
						}
						if (ev.perMiner.length > top.length) {
							lines.push(`… and ${ev.perMiner.length - top.length} more`);
						}
						return lines;
					},
				},
			},
		},
		scales: {
			x: {
				type: "linear" as const,
				grid: { color: "#222" },
				ticks: {
					color: "#aaa",
					maxTicksLimit: 8,
					autoSkip: true,
					callback: (v: any) => {
						// Local time, MM-DD HH:mm
						return localDateTimeInput(new Date(Number(v)))
							.slice(5)
							.replace("T", " ");
					},
				},
			},
			y: {
				beginAtZero: true,
				position: "left" as const,
				grid: { color: "#222" },
				ticks: {
					color: "#aaa",
					callback: (v: any) => `${Number(v).toFixed(2)}`,
				},
				title: { display: true, text: "α emitted", color: "#888" },
			},
			y1: {
				beginAtZero: true,
				position: "right" as const,
				grid: { drawOnChartArea: false },
				ticks: {
					color: GAP_LINE_COLOR,
					callback: (v: any) => `${Number(v)}`,
				},
				title: { display: true, text: "blocks since prev", color: GAP_LINE_COLOR },
			},
		},
	};

	const totalAlpha = alphaAsNumber(data.totalAlpha);
	const maxEv = data.events.reduce((mx, e) => (e.totalAlpha > mx ? e.totalAlpha : mx), 0n);

	const top = data.miners.slice(0, 10);

	return (
		<div className="cell">
			<h3>SN{data.netuid}</h3>
			<div className="meta">
				{data.events.length} event(s) · total {totalAlpha.toFixed(4)} α · max/event{" "}
				{alphaAsNumber(maxEv).toFixed(4)} α · {data.miners.length} unique miner(s)
				{medianGap !== null && <> · median gap {medianGap} blocks</>}
			</div>
			<Chart type="bar" data={chartData as any} options={options} height={110} />
			<div className="ops">
				{top.length === 0 ? (
					<span style={{ color: "#555" }}>no miners received emissions</span>
				) : (
					<>
						<span style={{ color: "#888" }}>top {top.length} miner(s) by total received:</span>
						{top.map((m) => (
							<div className="op" key={m.uid}>
								<span style={{ color: color, fontWeight: 600 }}>●</span> uid{" "}
								<span style={{ color: "#ddd" }}>{m.uid}</span> · {shortHk(m.hotkey)} ·{" "}
								{alphaAsNumber(m.total).toFixed(6)} α · {m.count} ev
							</div>
						))}
					</>
				)}
			</div>
		</div>
	);
}
