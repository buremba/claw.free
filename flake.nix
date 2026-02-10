{
  description = "claw.free — Free OpenClaw Installer";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_22
            nodePackages.npm
            google-cloud-sdk
          ];

          shellHook = ''
            echo "claw.free dev shell"
            echo "  node: $(node --version)"
            echo "  npm:  $(npm --version)"
          '';
        };

        # Package for the claw-free-provider (used on VM)
        packages.claw-free-provider = pkgs.buildNpmPackage {
          pname = "claw-free-provider";
          version = "1.0.0";
          src = ./provider;
          npmDepsHash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; # update after first build
          dontNpmBuild = true;
          installPhase = ''
            mkdir -p $out/lib/claw-free-provider
            cp -r . $out/lib/claw-free-provider
            mkdir -p $out/bin
            cat > $out/bin/claw-free-provider <<'WRAPPER'
            #!/usr/bin/env bash
            exec ${pkgs.nodejs_22}/bin/node $out/lib/claw-free-provider/server.js "$@"
            WRAPPER
            chmod +x $out/bin/claw-free-provider
          '';
        };

        # VM system profile — all packages needed on the GCP VM
        packages.vm-packages = pkgs.buildEnv {
          name = "claw-free-vm-packages";
          paths = with pkgs; [
            nodejs_22
            docker-compose
            git
            curl
            jq
          ];
        };
      }
    );
}
