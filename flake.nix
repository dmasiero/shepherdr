{
  # The fork's dev shell (FORK.md): what scripts/sync-upstream.sh and its checks need. renix runs the script in it
  # (`nix develop --command sh scripts/sync-upstream.sh …`) on every `renix full`. nixos-unstable for a Bun as new as
  # the Check workflow's (.github/workflows/check.yml).
  description = "Shepherdr (the dmasiero fork, 3.x line): dev shell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      each = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = each (pkgs: {
        default = pkgs.mkShell {
          packages = [ pkgs.bun pkgs.nodejs pkgs.python3 pkgs.git pkgs.gh pkgs.jq ];
        };
      });
    };
}
