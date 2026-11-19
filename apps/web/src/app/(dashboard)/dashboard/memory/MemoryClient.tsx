"use client"

/**
 * Dashboard page for the Hindsight memory stage.
 *
 * Three questions, in the order an operator asks them:
 *
 *   1. Is the service reachable, and where does it point? — the connection card.
 *   2. Which callers get memory? — the two switch lists, per key and per combo.
 *   3. What does it cost per turn? — recall budget, max tokens and timeout.
 *
 * There is deliberately no master switch. Enablement is per key or per combo, so
 * this page renders two independent lists rather than one global toggle: a single
 * switch here would hand memory to every caller at once, including a public combo
 * where one caller's conversation becomes another's context.
 */

import { useCallback, useEffect, useState } from "react"
import { Badge, Button, Card, Input, PageShell, Toggle } from "@/shared/components"
import { useNotificationStore } from "@/store/notificationStore"
import Icon from "../../../../shared/components/Icon"

interface KeyRow {
	id: string
	name: string
	isActive?: boolean
}

interface ComboRow {
	name: string
	memoryEnabled: boolean
	includeShared: boolean
}

interface MemoryStatus {
	optedInKeys: string[]
	combos: ComboRow[]
	/** False when this host still runs on the resolver's defaults. */
	configured: boolean
	baseUrl: string
	bankId: string
	recall: boolean
	retain: boolean
	includeShared: boolean
	sharedTags: string[]
	retainTags: string[]
	recallBudget: string
	recallMaxTokens: number
	timeoutMs: number
	apiKeyConfigured: boolean
	reachable: boolean
	breaker?: { open?: boolean; failures?: number }
}

const BUDGETS = ["low", "mid", "high"] as const

export default function MemoryClient() {
	const [status, setStatus] = useState<MemoryStatus | null>(null)
	const [keys, setKeys] = useState<KeyRow[]>([])
	const [loading, setLoading] = useState(true)
	const [busy, setBusy] = useState<string | null>(null)
	const addNotification = useNotificationStore((state) => state.addNotification)

	// Form state, seeded from the server once and then owned by the user so a
	// background refresh cannot overwrite what they are typing.
	const [baseUrl, setBaseUrl] = useState("")
	const [bankId, setBankId] = useState("")
	const [apiKey, setApiKey] = useState("")
	const [recall, setRecall] = useState(true)
	const [retain, setRetain] = useState(true)
	const [includeShared, setIncludeShared] = useState(true)
	const [sharedTags, setSharedTags] = useState("")
	const [retainTags, setRetainTags] = useState("")
	const [recallBudget, setRecallBudget] = useState<string>("mid")
	const [recallMaxTokens, setRecallMaxTokens] = useState("1200")
	const [timeoutMs, setTimeoutMs] = useState("8000")

	const load = useCallback(async () => {
		try {
			const [statusRes, keysRes] = await Promise.all([
				fetch("/api/memory", { cache: "no-store" }),
				fetch("/api/keys", { cache: "no-store" }),
			])
			if (statusRes.ok) {
				const data = (await statusRes.json()) as MemoryStatus
				setStatus(data)
				setBaseUrl(data.baseUrl ?? "")
				setBankId(data.bankId ?? "")
				setRecall(data.recall)
				setRetain(data.retain)
				setIncludeShared(data.includeShared)
				setSharedTags((data.sharedTags ?? []).join(", "))
				setRetainTags((data.retainTags ?? []).join(", "))
				setRecallBudget(data.recallBudget ?? "mid")
				setRecallMaxTokens(String(data.recallMaxTokens ?? 1200))
				setTimeoutMs(String(data.timeoutMs ?? 8000))
			}
			if (keysRes.ok) {
				const data = await keysRes.json()
				setKeys(Array.isArray(data.keys) ? data.keys : [])
			}
		} catch (err) {
			console.error("Failed to load memory status:", err)
		} finally {
			setLoading(false)
		}
	}, [])

	useEffect(() => {
		void load()
	}, [load])

	const post = useCallback(
		async (payload: Record<string, unknown>, key: string, successMessage: string) => {
			setBusy(key)
			try {
				const res = await fetch("/api/memory", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(payload),
				})
				if (!res.ok) {
					const body = await res.json().catch(() => ({}))
					throw new Error(body.error || "Request failed")
				}
				await load()
				addNotification({ type: "success", title: "Saved", message: successMessage })
			} catch (err) {
				addNotification({
					type: "error",
					title: "Error",
					message: err instanceof Error ? err.message : "Request failed",
				})
			} finally {
				setBusy(null)
			}
		},
		[addNotification, load],
	)

	const toggleKey = (key: KeyRow, enabled: boolean) => {
		void post(
			{ action: enabled ? "opt-in" : "opt-out", keyId: key.id },
			`key:${key.id}`,
			`Memory ${enabled ? "enabled" : "disabled"} for key "${key.name}".`,
		)
	}

	const toggleCombo = (combo: ComboRow, enabled: boolean) => {
		void post(
			{ action: enabled ? "combo-opt-in" : "combo-opt-out", comboName: combo.name },
			`combo:${combo.name}`,
			`Memory ${enabled ? "enabled" : "disabled"} for combo "${combo.name}".`,
		)
	}

	const saveConfig = () => {
		void post(
			{
				action: "save-config",
				config: {
					baseUrl,
					bankId,
					apiKey,
					recall,
					retain,
					includeShared,
					sharedTags: splitTags(sharedTags),
					retainTags: splitTags(retainTags),
					recallBudget,
					recallMaxTokens: Number(recallMaxTokens),
					timeoutMs: Number(timeoutMs),
				},
			},
			"config",
			"Memory configuration saved.",
		)
		setApiKey("")
	}

	if (loading) {
		return (
			<PageShell width="full" className="min-w-0">
				<p className="text-xs text-text-muted">Loading memory settings…</p>
			</PageShell>
		)
	}

	const optedIn = new Set(status?.optedInKeys ?? [])
	const reachable = status?.reachable ?? false
	const breakerOpen = status?.breaker?.open ?? false

	return (
		<PageShell width="full" className="min-w-0">
			<div className="flex flex-col gap-4 max-w-4xl">
				<div>
					<h1 className="text-xl font-bold text-text-main flex items-center gap-2">
						<Icon name="psychology" size={24} className="text-amber-500" />
						Memory (Hindsight)
					</h1>
					<p className="text-xs text-text-muted mt-1">
						Recall from and retain to a shared Hindsight bank. Off by default — enable it per API key or
						per combo, never globally.
					</p>
				</div>

				{/* Service health first: every switch below is pointless if the bank is
				    unreachable, and a stale breaker looks exactly like "memory is off". */}
				<Card>
					<div className="flex flex-wrap items-center gap-3">
						<Badge variant={reachable ? "success" : "error"}>
							{reachable ? "Reachable" : "Unreachable"}
						</Badge>
						{breakerOpen ? <Badge variant="warning">Circuit breaker open</Badge> : null}
						<span className="text-xs text-text-muted">
							Bank <code className="text-text-main">{status?.bankId || "—"}</code> at{" "}
							<code className="text-text-main">{status?.baseUrl || "not configured"}</code>
						</span>
						<Button variant="ghost" size="sm" onClick={() => void load()}>
							Refresh
						</Button>
					</div>
					{/* Each host keeps its own settings row, so a URL here that nobody chose is
					    the resolver's default, not a configuration. Say so instead of letting
					    localhost:8888 read like a real target. */}
					{status?.configured === false ? (
						<p className="text-xs text-warning mt-2">
							This host has no memory configuration yet — the values below are defaults. Fill in the
							Hindsight URL and bank, then save.
						</p>
					) : null}
				</Card>

				{/* Per-key switches */}
				<Card>
					<div className="flex flex-col gap-3">
						<div>
							<h2 className="text-sm font-semibold text-text-main">Per API key</h2>
							<p className="text-xs text-text-muted mt-1">
								A key that is on runs the stage even when the combo it calls says nothing. Everything else
								stays off.
							</p>
						</div>
						{keys.length === 0 ? (
							<p className="text-xs text-text-muted">No API keys yet.</p>
						) : (
							<div className="flex flex-col divide-y divide-border-subtle">
								{keys.map((key) => (
									<div key={key.id} className="flex items-center justify-between gap-3 py-2">
										<div className="min-w-0">
											<p className="text-xs font-medium text-text-main truncate">{key.name}</p>
											<p className="text-[10px] text-text-muted font-mono truncate">{key.id}</p>
										</div>
										<Toggle
											checked={optedIn.has(key.id)}
											disabled={busy === `key:${key.id}`}
											onChange={(next) => toggleKey(key, next)}
										/>
									</div>
								))}
							</div>
						)}
					</div>
				</Card>

				{/* Per-combo switches */}
				<Card>
					<div className="flex flex-col gap-3">
						<div>
							<h2 className="text-sm font-semibold text-text-main">Per combo</h2>
							<p className="text-xs text-text-muted mt-1">
								A combo that is on carries memory for every caller it serves, whichever key they use.
							</p>
						</div>
						{!status?.combos?.length ? (
							<p className="text-xs text-text-muted">
								No combos have a memory block yet. Enable one here and the entry is created.
							</p>
						) : (
							<div className="flex flex-col divide-y divide-border-subtle">
								{status.combos.map((combo) => (
									<div key={combo.name} className="flex items-center justify-between gap-3 py-2">
										<div className="min-w-0">
											<p className="text-xs font-medium text-text-main truncate">{combo.name}</p>
											<p className="text-[10px] text-text-muted">
												{combo.memoryEnabled ? "memory on" : "memory off"}
												{combo.memoryEnabled && !combo.includeShared ? " · own memories only" : ""}
											</p>
										</div>
										<Toggle
											checked={combo.memoryEnabled}
											disabled={busy === `combo:${combo.name}`}
											onChange={(next) => toggleCombo(combo, next)}
										/>
									</div>
								))}
							</div>
						)}
					</div>
				</Card>

				{/* Connection + tuning */}
				<Card>
					<div className="flex flex-col gap-4">
						<div>
							<h2 className="text-sm font-semibold text-text-main">Connection &amp; tuning</h2>
							<p className="text-xs text-text-muted mt-1">
								Where the bank lives and what one recall may cost. These apply to every caller that has
								memory enabled.
							</p>
						</div>

						<div className="grid gap-3 sm:grid-cols-2">
							<label className="flex flex-col gap-1" htmlFor="memory-base-url">
								<span className="text-xs text-text-muted">Hindsight URL</span>
								<Input
									id="memory-base-url"
									value={baseUrl}
									onChange={(e) => setBaseUrl(e.target.value)}
									placeholder="http://localhost:8888"
								/>
							</label>
							<label className="flex flex-col gap-1" htmlFor="memory-bank-id">
								<span className="text-xs text-text-muted">Bank ID</span>
								<Input
									id="memory-bank-id"
									value={bankId}
									onChange={(e) => setBankId(e.target.value)}
									placeholder="9router"
								/>
							</label>
							<label className="flex flex-col gap-1 sm:col-span-2" htmlFor="memory-api-key">
								<span className="text-xs text-text-muted">
									Bearer token {status?.apiKeyConfigured ? "(configured — leave blank to keep)" : "(none)"}
								</span>
								<Input
									id="memory-api-key"
									type="password"
									value={apiKey}
									onChange={(e) => setApiKey(e.target.value)}
									placeholder={status?.apiKeyConfigured ? "••••••••" : "optional"}
								/>
							</label>
							<label className="flex flex-col gap-1" htmlFor="memory-api-key">
								<span className="text-xs text-text-muted">Recall budget</span>
								<select
									id="memory-budget"
									className="h-9 rounded-md border border-border-subtle bg-bg-subtle px-2 text-xs text-text-main"
									value={recallBudget}
									onChange={(e) => setRecallBudget(e.target.value)}
								>
									{BUDGETS.map((budget) => (
										<option key={budget} value={budget}>
											{budget}
										</option>
									))}
								</select>
							</label>
							<label className="flex flex-col gap-1" htmlFor="memory-budget">
								<span className="text-xs text-text-muted">Recall max tokens</span>
								<Input
									id="memory-max-tokens"
									value={recallMaxTokens}
									onChange={(e) => setRecallMaxTokens(e.target.value)}
									inputMode="numeric"
								/>
							</label>
							<label className="flex flex-col gap-1" htmlFor="memory-max-tokens">
								<span className="text-xs text-text-muted">
									Timeout (ms) — a recall that takes longer injects nothing
								</span>
								<Input
									value={timeoutMs}
									onChange={(e) => setTimeoutMs(e.target.value)}
									inputMode="numeric"
								/>
							</label>
							<label className="flex flex-col gap-1" htmlFor="memory-timeout">
								<span className="text-xs text-text-muted">
									Shared tags (comma separated) — extra tags OR&apos;d into recall
								</span>
								<Input
									id="memory-shared-tags"
									value={sharedTags}
									onChange={(e) => setSharedTags(e.target.value)}
									placeholder="host:omarchy"
								/>
							</label>
							<label className="flex flex-col gap-1 sm:col-span-2" htmlFor="memory-retain-tags">
								<span className="text-xs text-text-muted">
									Retain tags — leave empty for a public bank; these publish chats to every reader
								</span>
								<Input
									id="memory-retain-tags"
									value={retainTags}
									onChange={(e) => setRetainTags(e.target.value)}
									placeholder=""
								/>
							</label>
						</div>

						<div className="flex flex-col gap-2">
							<Toggle
								checked={recall}
								onChange={setRecall}
								label="Recall"
								description="Inject relevant memories into the prompt."
							/>
							<Toggle
								checked={retain}
								onChange={setRetain}
								label="Retain"
								description="Write new conversation turns back to the bank."
							/>
							<Toggle
								checked={includeShared}
								onChange={setIncludeShared}
								label="Include shared corpus"
								description="Also return the bank's untagged/shared memories. Turn off for a public combo."
							/>
						</div>

						<div className="flex justify-end">
							<Button variant="primary" size="sm" disabled={busy === "config"} onClick={saveConfig}>
								Save configuration
							</Button>
						</div>
					</div>
				</Card>
			</div>
		</PageShell>
	)
}

/** Comma-separated input to a tag list, trimmed and de-duplicated. */
function splitTags(value: string): string[] {
	const seen = new Set<string>()
	for (const part of value.split(",")) {
		const tag = part.trim()
		if (tag) seen.add(tag)
	}
	return [...seen]
}
