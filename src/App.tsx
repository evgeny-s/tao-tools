import { useState } from "react";
import MyStake from "./tabs/MyStake";

type Tab = "my-stake";

export default function App() {
	const [tab, setTab] = useState<Tab>("my-stake");
	return (
		<div className="app">
			<h1>TAO tools</h1>
			<div className="tabs">
				<button
					className={`tab ${tab === "my-stake" ? "active" : ""}`}
					onClick={() => setTab("my-stake")}
				>
					My stake
				</button>
			</div>
			{tab === "my-stake" && <MyStake />}
		</div>
	);
}
