import { useState } from "react";
import Logo from "./components/Logo";
import { DEFAULT_RPC } from "./lib/fetcher";
import BlockWeight from "./tabs/BlockWeight";
import Conviction from "./tabs/Conviction";
import MinerEmissions from "./tabs/MinerEmissions";
import MyStake from "./tabs/MyStake";

type Tab = "my-stake" | "miner-emissions" | "conviction" | "block-weight";

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
				<button
					className={`tab ${tab === "conviction" ? "active" : ""}`}
					onClick={() => setTab("conviction")}
				>
					Conviction
				</button>
				<button
					className={`tab ${tab === "block-weight" ? "active" : ""}`}
					onClick={() => setTab("block-weight")}
				>
					Block weight
				</button>
			</div>
			{tab === "my-stake" && <MyStake rpc={rpc} />}
			{tab === "miner-emissions" && <MinerEmissions rpc={rpc} />}
			{tab === "conviction" && <Conviction rpc={rpc} />}
			{tab === "block-weight" && <BlockWeight rpc={rpc} />}
		</div>
	);
}
