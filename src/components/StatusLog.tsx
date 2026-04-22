import { useEffect, useRef } from "react";
import type { StatusUpdate } from "../lib/fetcher";

export default function StatusLog({ entries }: { entries: StatusUpdate[] }) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
	}, [entries]);

	return (
		<div className="status-log" ref={ref}>
			{entries.map((u, i) => {
				const msg =
					u.kind === "progress" && u.done != null && u.total != null
						? `  ${u.message} ${u.done}/${u.total} (${Math.round((u.done / u.total) * 100)}%)`
						: u.message;
				return (
					<div key={i} className={`line ${u.kind}`}>
						{u.kind === "done" ? "✓ " : u.kind === "error" ? "✗ " : ""}
						{msg}
					</div>
				);
			})}
		</div>
	);
}
