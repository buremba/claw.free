{
  description = "claw.free NixOS base module for OpenClaw VMs";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";
    nixos-generators.url = "github:nix-community/nixos-generators";
    nixos-generators.inputs.nixpkgs.follows = "nixpkgs";
    clawfree = {
      url = "path:../../..";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, nixos-generators, clawfree, ... }:
    let
      system = "x86_64-linux";
      module = import ./default.nix;
    in {
      nixosModules.default = module;

      packages.${system}.gcp-image = nixos-generators.nixosGenerate {
        inherit system;
        format = "gce";
        specialArgs = {
          clawfreeRoot = clawfree;
        };
        modules = [
          module
          ({ ... }: {
            services.clawFree.enable = true;
            system.stateVersion = "24.11";
          })
        ];
      };
    };
}
