"use client"

import { useRouter, useSearchParams } from "next/navigation"
import { Suspense, useState } from "react"
import { CardSkeleton, RequestLogger, SegmentedControl } from "@/shared/components"
import UsageStats from "@/shared/components/UsageStats"
import ErrorClassificationTab from "./components/ErrorClassificationTab.tsx"
import HealthTab from "./components/HealthTab.tsx"
import ModelLeaderboardTab from "./components/ModelLeaderboardTab.tsx"
import RequestDetailsTab from "./components/RequestDetailsTab.tsx"
import TokenSavingsTab from "./components/TokenSavingsTab.tsx"

const PERIODS = [
	{ value: "today", label: "Today" },
	{ value: "24h", label: "24h" },
	{ value: "7d", label: "7D" },
	{ value: "30d", label: "30D" },
	{ value: "60d", label: "60D" },
	{ value: "all", label: "All" },
]

export default function UsagePage() {
	return (
		<Suspense fallback={<CardSkeleton />}>
			<UsageContent />
		</Suspense>
	)
}

function UsageContent() {
	const searchParams = useSearchParams()
	const router = useRouter()

	const [period, setPeriod] = useState("today")

	const tabFromUrl = searchParams.get("tab")
	const activeTab =
		tabFromUrl &&
		["overview", "logs", "details", "errors", "leaderboard", "savings", "health"].includes(tabFromUrl)
			? tabFromUrl
			: "overview"

	const handleTabChange = (value) => {
		if (value === activeTab) return
		const params = new URLSearchParams(searchParams)
		params.set("tab", value)
		router.push(`/dashboard/usage?${params.toString()}`, { scroll: false })
	}

	return (
		<div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
			{/* Tabs + period selector on same row */}
			<div className="flex flex-col flex-wrap gap-2 sm:flex-row sm:items-center sm:justify-between">
				<SegmentedControl
					options={[
						{ value: "overview", label: "Overview" },
						{ value: "details", label: "Details" },
						{ value: "errors", label: "Errors" },
						{ value: "leaderboard", label: "Leaderboard" },
						{ value: "savings", label: "Savings" },
						{ value: "health", label: "Health" },
					]}
					value={activeTab}
					onChange={handleTabChange}
					className="w-full sm:w-auto"
				/>
				{(activeTab === "overview" ||
					activeTab === "errors" ||
					activeTab === "leaderboard" ||
					activeTab === "savings" ||
					activeTab === "health") && (
					<SegmentedControl
						options={PERIODS}
						value={period}
						onChange={setPeriod}
						size="sm"
						className="w-full sm:w-auto"
					/>
				)}
			</div>

			{activeTab === "overview" && (
				<Suspense fallback={<CardSkeleton />}>
					<UsageStats period={period} setPeriod={setPeriod} hidePeriodSelector />
				</Suspense>
			)}
			{activeTab === "logs" && <RequestLogger />}
			{activeTab === "details" && <RequestDetailsTab />}
			{activeTab === "errors" && <ErrorClassificationTab period={period} />}
			{activeTab === "leaderboard" && <ModelLeaderboardTab period={period} />}
			{activeTab === "savings" && <TokenSavingsTab period={period} />}
			{activeTab === "health" && <HealthTab period={period} />}
		</div>
	)
}
