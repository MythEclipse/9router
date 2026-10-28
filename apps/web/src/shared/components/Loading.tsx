"use client"

import type { HTMLAttributes, ReactNode } from "react"
import { cn } from "@/shared/utils/cn"

// Loading surfaces that stay inside their own container: a spinner, a full-page block, a
// skeleton. Long-running work does NOT live here - it reports through the task store into the
// notification bell (`taskStore` -> `NotifToast`). The floating banner and its wrappers
// (the floating banner and its inline wrappers) are gone: a fixed overlay
// rendered nothing, and the inline variant covered the very form it sat in.

// Spinner loading
const SPINNER_SIZES = {
	sm: "size-4",
	md: "size-6",
	lg: "size-8",
	xl: "size-12",
}

export type SpinnerSize = keyof typeof SPINNER_SIZES

export interface SpinnerProps {
	size?: SpinnerSize
	className?: string
}

export function Spinner({ size = "md", className }: SpinnerProps) {
	const sizes = SPINNER_SIZES

	return (
		<span
			className={cn("material-symbols-outlined animate-spin text-brand-500", sizes[size], className)}
		>
			progress_activity
		</span>
	)
}

// Full page loading
export function PageLoading({ message = "Loading..." }: { message?: ReactNode }) {
	return (
		<div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-bg">
			<Spinner size="xl" />
			<p className="mt-4 text-text-muted">{message}</p>
		</div>
	)
}

// Skeleton loading
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
	return <div className={cn("animate-pulse rounded-[10px] bg-surface-2", className)} {...props} />
}

// Card skeleton
export function CardSkeleton() {
	return (
		<div className="p-6 rounded-[14px] border border-border-subtle bg-surface shadow-[var(--shadow-soft)]">
			<div className="flex items-center justify-between mb-4">
				<Skeleton className="h-4 w-24" />
				<Skeleton className="size-10 rounded-[10px]" />
			</div>
			<Skeleton className="h-8 w-16 mb-2" />
			<Skeleton className="h-3 w-20" />
		</div>
	)
}

export type LoadingProps =
	| ({ type: "spinner" } & SpinnerProps)
	| ({ type: "page" } & { message?: ReactNode })
	| ({ type: "skeleton" } & HTMLAttributes<HTMLDivElement>)
	| { type: "card" }

export default function Loading({ type = "spinner", ...props }: LoadingProps) {
	switch (type) {
		case "page":
			return <PageLoading {...(props as { message?: ReactNode })} />
		case "skeleton":
			return <Skeleton {...(props as HTMLAttributes<HTMLDivElement>)} />
		case "card":
			return <CardSkeleton />
		default:
			return <Spinner {...(props as SpinnerProps)} />
	}
}
