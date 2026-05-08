import { useState } from "react";
import Logo from "./components/Logo";
import { DEFAULT_RPC } from "./lib/fetcher";
import MinerEmissions from "./tabs/MinerEmissions";
import MyStake from "./tabs/MyStake";

type Tab = "my-stake" | "miner-emissions";

export default function App() {
	const [tab, setTab] = useState<Tab>("my-stake");
	const [rpc, setRpc] = useState(DEFAULT_RPC);
	return (
		<div className="app">
			<header className="topbar">
				<Logo />
				<label className="rpc-control">
					<span className="rpc-control-label">RPC</span>
					<input
						className="rpc-control-input"
						value={rpc}
						onChange={(e) => setRpc(e.target.value)}
						placeholder={DEFAULT_RPC}
						spellCheck={false}
					/>
				</label>
			</header>
			<div className="tabs">
				<button
					className={`tab ${tab === "my-stake" ? "active" : ""}`}
					onClick={() => setTab("my-stake")}
				>
					Stake
				</button>
				<button
					className={`tab ${tab === "miner-emissions" ? "active" : ""}`}
					onClick={() => setTab("miner-emissions")}
				>
					Miner emissions
				</button>
			</div>
			{tab === "my-stake" && <MyStake rpc={rpc} />}
			{tab === "miner-emissions" && <MinerEmissions rpc={rpc} />}
		</div>
	);
}
