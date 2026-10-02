{
  description = "9Router — AI routing gateway + Next.js dashboard (Nix build)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        # Build identifier = the git commit this flake was built from, so the
        # nix store path is "-9router-<shortsha>" and a deployed build can be
        # traced back to its exact source commit (versioning by git SHA, no
        # package.json version bumps needed). Falls back to "dirty" when the
        # tree isn't a clean git checkout (self.shortRev is only defined when
        # the flake lives in a git repo with no uncommitted changes).
        rev = self.shortRev or self.rev or "dirty";
        pkgs = import nixpkgs {
          inherit system;
          overlays = [
            (self: super: {
              bun = super.bun.overrideAttrs (old: rec {
                version = "1.4.0";
                src = super.fetchzip {
                  url = "https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-linux-x64.zip";
                  sha256 = "sha256:Poy0vf7yJ/hzk33QiQj5gnshI5Q7dfbaMD7xgwiyDKw=";
                };
              });
            })
          ];
        };
        nodejs = pkgs.nodejs_22;
      in {
        packages.default = pkgs.stdenv.mkDerivation {
          pname = "9router";
          version = rev;
          src = ./.;

          nativeBuildInputs = [
            pkgs.bun
            pkgs.git
            pkgs.python3
            pkgs.gnumake
            pkgs.gcc
            pkgs.cacert
            pkgs.makeBinaryWrapper
          ];

          buildPhase = ''
            export HOME=$TMPDIR/home
            export npm_config_cache=$TMPDIR/npm-cache
            mkdir -p "$npm_config_cache" "$HOME"

            # SSL/TLS certs (Nix sandbox doesn't have system CA bundle)
            export SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt
            export NODE_EXTRA_CA_CERTS=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt

            echo "=== bun install ==="
            bun install 2>&1

            echo "=== bun run build (next build --webpack) ==="
            # Inline the git SHA into the client bundle so the dashboard header
            # shows "v0.5.86 (<shortsha>)" — traceable build identity in the UI.
            export NEXT_PUBLIC_GIT_SHA="${rev}"
            bun run build 2>&1

            echo "=== Build complete ==="
          '';

          installPhase = ''
            mkdir -p $out/bin $out/lib/9router

            # Next.js standalone output (self-contained server + traced node_modules)
            cp -r .next/standalone/* $out/lib/9router/
            # Full node_modules from bun install — standalone trace can miss deps
            # (e.g. undici for /v1/chat executor); overwrite traced subset
            rm -rf $out/lib/9router/node_modules
            cp -r node_modules $out/lib/9router/node_modules
            # Full .next build (BUILD_ID, server chunks, static) — standalone output
            # may omit it depending on Next version; the server requires it at runtime
            cp -r .next $out/lib/9router/.next
            rm -rf $out/lib/9router/.next/cache $out/lib/9router/.next/standalone
            # Runtime engine + source dirs the standalone server traces/fetches
            cp -r open-sse $out/lib/9router/open-sse 2>/dev/null || true
            cp -r src $out/lib/9router/src 2>/dev/null || true
            # Public assets
            cp -r public $out/lib/9router/public 2>/dev/null || true
            # Custom server (IP derivation, header sanitisation)
            cp custom-server.js $out/lib/9router/custom-server.js

            # Wrapper — cd into lib dir so process.cwd() resolves (Drizzle/relative lookups)
            cat > $out/bin/9router << WRAPPER
#!${pkgs.runtimeShell}
export PATH=${nodejs}/bin:\$PATH
cd $out/lib/9router
exec ${nodejs}/bin/node custom-server.js
WRAPPER
            chmod +x $out/bin/9router
          '';
        };
      });
}
