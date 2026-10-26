"use client";

import { useState } from "react";
import Image from "next/image";
import { getProviderIconSrc, markProviderIconMissing } from "@/shared/utils/providerIcon";

function resolveSrc(src, providerId) {
  if (providerId) return getProviderIconSrc(providerId);
  if (!src) return null;
  const m = String(src).match(/^\/providers\/([^/]+)\.png$/i);
  if (m) return getProviderIconSrc(m[1]);
  return src;
}

interface ProviderIconProps {
  src?: string
  providerId?: string
  alt?: string
  size?: number
  className?: string
  fallbackText?: string
  fallbackColor?: string
}

export default function ProviderIcon({
  src,
  providerId,
  alt,
  size = 32,
  className = "",
  fallbackText = "?",
  fallbackColor,
}: ProviderIconProps) {
  const effectiveSrc = resolveSrc(src, providerId);
  const [errored, setErrored] = useState(false);

  if (!effectiveSrc || errored) {
    return (
      <span
        className={`inline-flex items-center justify-center font-bold rounded-lg ${className}`.trim()}
        style={{
          width: size,
          height: size,
          color: fallbackColor,
          fontSize: Math.max(10, Math.floor(size * 0.38)),
        }}
      >
        {fallbackText}
      </span>
    );
  }

  return (
    // unoptimized keeps the markup identical to the plain <img> that was here
    // before: no loader runs, so the onError fallback below still fires on a
    // missing icon exactly as it did.
    <Image
      src={effectiveSrc}
      alt={alt}
      width={size}
      height={size}
      unoptimized
      className={className}
      onError={() => {
        const m = effectiveSrc.match(/^\/providers\/([^/]+)\.png$/i);
        if (m) markProviderIconMissing(m[1]);
        if (providerId) markProviderIconMissing(providerId);
        setErrored(true);
      }}
    />
  );
}

