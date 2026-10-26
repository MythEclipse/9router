import { isOpencodeFreeModel } from "@/shared/utils/modelTier";

interface ModelTierBadgeProps {
  model?: string | object
  providerId?: string
  isFree?: boolean
  className?: string
}

export default function ModelTierBadge({ model, providerId, isFree, className = "" }: ModelTierBadgeProps) {
  if (!isOpencodeFreeModel(model, providerId, isFree)) {
    return null;
  }

  return (
    <span
      title="Free Model (Free Tier)"
      className={`shrink-0 inline-flex items-center gap-1 text-[9px] font-bold tracking-wider text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/25 px-1.5 py-0.5 rounded leading-none align-middle ${className}`}
    >
      <span className="material-symbols-outlined text-[10px] leading-none select-none">sell</span>
      FREE
    </span>
  );
}

