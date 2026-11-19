#!/usr/bin/env bash
#
# Install ffmpeg for the CI test suite, without depending on a single flaky host.
#
# Why this is a script and not one apt line
# ----------------------------------------
# The codex-stt-* tests shell out to the real `ffmpeg` (docs/CODEX_STT.md: audio is
# converted to mono 24 kHz PCM16 locally before upload), so the runner needs the
# binary, not a mock. The old step was:
#
#     sudo apt-get update && sudo apt-get install -y --no-install-recommends ffmpeg
#
# On one runner that took 879 s and then failed; on another, the same step took
# 16 s. Same image, same 66.4 MB of packages. The difference was the HOST apt
# chose per package:
#
#     azure.archive.ubuntu.com  -> 67 packages OK (11-18 MB/s)
#     security.ubuntu.com       -> 27 packages FAILED
#                                  "Could not wait for server fd - select (11:
#                                   Resource temporarily unavailable)"  [EAGAIN]
#
# So the archive mirror was fast while the security pocket host hung until apt
# gave up. Retrying that host does not help when it is unreachable from a given
# runner: the fix is to stop asking it. Ubuntu archive mirrors carry the
# `-security` pocket too (the same log shows `resolute-security/main` package
# indexes being fetched from azure.archive.ubuntu.com), so pointing every apt
# source at the archive host is both correct and fast.
#
# Three layers, cheapest first:
#   1. Already installed?  (a cache hit from a previous run)      -> done
#   2. apt, with sources rewritten to one host, plus retries      -> normal path
#   3. static build downloaded straight from GitHub               -> no apt at all
#
# Layer 3 exists because a CI gate must not be defeatable by one host being
# unreachable. It is not a nicety: without it, a runner that cannot reach
# security.ubuntu.com can never run the test suite at all.
#
# Usage:
#   scripts/ci-install-ffmpeg.sh [--cache-dir DIR]
#
# --cache-dir is where a previously downloaded static binary may live, so a
# workflow can cache it and skip everything else.

set -uo pipefail

CACHE_DIR=""
while [ $# -gt 0 ]; do
	case "$1" in
	--cache-dir)
		CACHE_DIR="${2:-}"
		shift 2
		;;
	*)
		echo "ci-install-ffmpeg: unknown argument: $1" >&2
		exit 2
		;;
	esac
done

log() { printf '[ffmpeg] %s\n' "$*"; }

# GitHub runners run as a non-root user with passwordless sudo; a container may be
# root already, or have no sudo at all. Resolve it once instead of assuming.
if [ "$(id -u)" -eq 0 ]; then
	SUDO=""
elif command -v sudo >/dev/null 2>&1; then
	SUDO="sudo"
else
	log "ERROR: not root and sudo is unavailable; cannot install ffmpeg" >&2
	exit 1
fi

# A working ffmpeg is the only thing this script promises, so that is the check.
# Check the absolute paths we install to as well as PATH: a caller's PATH may not
# include /usr/local/bin, and "installed but not visible" must not be reported as
# a failure that sends us down the download path again.
ffmpeg_works() {
	local candidate
	for candidate in "$(command -v ffmpeg 2>/dev/null)" /usr/local/bin/ffmpeg /usr/bin/ffmpeg; do
		[ -n "$candidate" ] || continue
		[ -x "$candidate" ] || continue
		if "$candidate" -version >/dev/null 2>&1; then
			FFMPEG_BIN="$candidate"
			return 0
		fi
	done
	return 1
}
FFMPEG_BIN=""

if ffmpeg_works; then
	log "already installed: $("$FFMPEG_BIN" -version | head -1)"
	exit 0
fi

# --- Layer 1: a cached static binary from a previous run ---------------------
if [ -n "$CACHE_DIR" ] && [ -x "$CACHE_DIR/ffmpeg" ] && [ -x "$CACHE_DIR/ffprobe" ]; then
	log "installing cached build from $CACHE_DIR"
	$SUDO install -m 0755 "$CACHE_DIR/ffmpeg" /usr/local/bin/ffmpeg
	$SUDO install -m 0755 "$CACHE_DIR/ffprobe" /usr/local/bin/ffprobe
	if ffmpeg_works; then
		log "cached build installed: $("$FFMPEG_BIN" -version | head -1)"
		exit 0
	fi
	log "cached build did not run; falling through to apt"
fi

# --- Layer 2: apt, with every source pinned to the working archive host ------
#
# Pick the host that is actually serving the archive in this image rather than
# hardcoding one. `azure.archive.ubuntu.com` is what GitHub's Ubuntu runners use;
# the fallback keeps this working on a plain ubuntu image too.
detect_archive_host() {
	local host=""
	# Ubuntu 24.04+ uses deb822 (`URIs:` lines in *.sources); older images use the
	# one-line `deb http://host/...` format. Cover both, and never pick the security
	# host - that is the one that hangs.
	local sources=()
	[ -r /etc/apt/sources.list ] && sources+=(/etc/apt/sources.list)
	if [ -d /etc/apt/sources.list.d ]; then
		while IFS= read -r f; do
			[ -n "$f" ] && sources+=("$f")
		done < <(find /etc/apt/sources.list.d -maxdepth 1 -type f \
			\( -name '*.list' -o -name '*.sources' \) 2>/dev/null)
	fi
	for f in "${sources[@]}"; do
		[ -r "$f" ] || continue
		host=$(grep -hoE '(URIs:|deb )[^#]*https?://[^/ ]+' "$f" 2>/dev/null |
			grep -oE 'https?://[^/ ]+' |
			sed -E 's#https?://##' |
			grep -v 'security\.ubuntu\.com' |
			head -1)
		[ -n "$host" ] && break
	done
	# The runner image points at the Azure mirror; keep that as the default.
	if [ -z "$host" ]; then host="azure.archive.ubuntu.com"; fi
	printf '%s' "$host"
}

rewrite_apt_sources() {
	local host="$1"
	local files=()
	[ -r /etc/apt/sources.list ] && files+=(/etc/apt/sources.list)
	if [ -d /etc/apt/sources.list.d ]; then
		while IFS= read -r f; do
			[ -n "$f" ] && files+=("$f")
		done < <(find /etc/apt/sources.list.d -maxdepth 1 -type f \
			\( -name '*.list' -o -name '*.sources' \) 2>/dev/null)
	fi
	if [ ${#files[@]} -eq 0 ]; then
		log "no apt source files found; leaving sources alone"
		return 0
	fi
	local changed=0
	for f in "${files[@]}"; do
		[ -r "$f" ] || continue
		if grep -q 'security\.ubuntu\.com' "$f" 2>/dev/null; then
			log "rewriting security.ubuntu.com -> $host in $f"
			$SUDO sed -i "s#security\.ubuntu\.com#$host#g" "$f"
			changed=1
		fi
	done
	[ "$changed" -eq 0 ] && log "no security.ubuntu.com source to rewrite"
	return 0
}

apt_install_ffmpeg() {
	# Retries and a bounded timeout: a hanging socket should fail fast and be
	# retried, not consume the job's whole budget.
	local opts=(
		-o Acquire::Retries=5
		-o Acquire::http::Timeout=20
		-o Acquire::https::Timeout=20
		# Pipelining is the usual source of "Could not wait for server fd" on
		# congested mirrors; one request at a time is slower but reliable.
		-o Acquire::http::Pipeline-Depth=0
	)
	$SUDO apt-get "${opts[@]}" update
	$SUDO apt-get "${opts[@]}" install -y --no-install-recommends ffmpeg
}

if command -v apt-get >/dev/null 2>&1; then
	ARCHIVE_HOST="$(detect_archive_host)"
	log "archive host: $ARCHIVE_HOST"
	rewrite_apt_sources "$ARCHIVE_HOST"
	if apt_install_ffmpeg && ffmpeg_works; then
		log "installed via apt: $("$FFMPEG_BIN" -version | head -1)"
		exit 0
	fi
	log "apt install failed; falling back to a static build"
else
	log "apt-get not available; using a static build"
fi

# --- Layer 3: static build, no package manager involved ----------------------
#
# BtbN's builds are published as GitHub release assets, so this rides the same
# CDN the runner already uses to fetch actions - no Ubuntu mirror involved.
download_static_ffmpeg() {
	local url="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz"
	local tmp
	tmp="$(mktemp -d)"

	# Fetch with whatever is present. A slim image may have none of curl/wget, and
	# apt (which could install one) is exactly what just failed - so try them in
	# order and say clearly when nothing is available.
	local fetch=""
	if command -v curl >/dev/null 2>&1; then
		fetch="curl"
	elif command -v wget >/dev/null 2>&1; then
		fetch="wget"
	fi
	if [ -z "$fetch" ]; then
		log "no curl or wget available to download a static build"
		rm -rf "$tmp"
		return 1
	fi

	log "downloading static build with $fetch: $url"
	local ok=1
	if [ "$fetch" = "curl" ]; then
		curl -fsSL --retry 5 --retry-delay 2 --connect-timeout 20 --max-time 600 \
			-o "$tmp/ffmpeg.tar.xz" "$url" || ok=0
	else
		wget -q --tries=5 --timeout=20 --output-document="$tmp/ffmpeg.tar.xz" "$url" || ok=0
	fi
	if [ "$ok" -ne 1 ]; then
		log "static download failed"
		rm -rf "$tmp"
		return 1
	fi

	# BtbN only publishes .tar.xz, so xz support is required to unpack it. On a
	# GitHub runner xz-utils is present; on a slim image it may not be, and apt is
	# the thing that just failed - so try the available extractors in order and
	# only then reach for a package install.
	extract_archive() {
		local archive="$1" dest="$2"
		if tar -xJf "$archive" -C "$dest" 2>/dev/null; then return 0; fi
		if command -v unxz >/dev/null 2>&1 || command -v xz >/dev/null 2>&1; then
			local plain="$dest/unpacked.tar"
			if xz -dc "$archive" >"$plain" 2>/dev/null &&
				tar -xf "$plain" -C "$dest" 2>/dev/null; then
				rm -f "$plain"
				return 0
			fi
			rm -f "$plain"
		fi
		if command -v python3 >/dev/null 2>&1; then
			if python3 - "$archive" "$dest" <<-'PY' 2>/dev/null
				import sys, tarfile
				tarfile.open(sys.argv[1]).extractall(sys.argv[2])
			PY
			then return 0; fi
		fi
		# Last resort: a tiny package install from the archive host we already
		# pinned, not from the security host that was hanging.
		if command -v apt-get >/dev/null 2>&1; then
			log "installing xz-utils to unpack the static build"
			if $SUDO apt-get install -y --no-install-recommends xz-utils >/dev/null 2>&1 &&
				tar -xJf "$archive" -C "$dest" 2>/dev/null; then
				return 0
			fi
		fi
		return 1
	}

	if ! extract_archive "$tmp/ffmpeg.tar.xz" "$tmp"; then
		log "static archive did not extract (no xz support available)"
		rm -rf "$tmp"
		return 1
	fi
	local bin
	bin="$(find "$tmp" -type f -name ffmpeg -perm -u+x | head -1)"
	if [ -z "$bin" ]; then
		log "no ffmpeg binary inside the archive"
		rm -rf "$tmp"
		return 1
	fi
	local dir
	dir="$(dirname "$bin")"
	$SUDO install -m 0755 "$dir/ffmpeg" /usr/local/bin/ffmpeg
	[ -f "$dir/ffprobe" ] && $SUDO install -m 0755 "$dir/ffprobe" /usr/local/bin/ffprobe
	# Persist for the workflow cache so the next run skips both apt and download.
	if [ -n "$CACHE_DIR" ]; then
		mkdir -p "$CACHE_DIR"
		cp "$dir/ffmpeg" "$CACHE_DIR/ffmpeg"
		[ -f "$dir/ffprobe" ] && cp "$dir/ffprobe" "$CACHE_DIR/ffprobe"
		log "cached static build in $CACHE_DIR"
	fi
	rm -rf "$tmp"
	return 0
}

if download_static_ffmpeg && ffmpeg_works; then
	log "installed static build: $("$FFMPEG_BIN" -version | head -1)"
	exit 0
fi

log "ERROR: could not install a working ffmpeg" >&2
exit 1
