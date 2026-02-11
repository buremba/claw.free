{ config, lib, pkgs, clawfreeRoot, ... }:
let
  cfg = config.services.clawFree;

  stateDir = "/var/lib/openclaw";
  npmPrefix = "${stateDir}/npm-global";
  homeDir = "${stateDir}/home";
  configDir = "${homeDir}/.openclaw";
  configPath = "${configDir}/openclaw.json";
  workspaceDir = "${configDir}/workspace";
  providerDir = "${stateDir}/provider";
  providerEnvPath = "${stateDir}/provider.env";
  setupMarker = "${stateDir}/.setup-complete";
  guestAttributeSetupUrl = "http://metadata.google.internal/computeMetadata/v1/instance/guest-attributes/openclaw/setup";
  aiToolsMarker = "${stateDir}/.ai-clis-installed";
in
{
  options.services.clawFree = {
    enable = lib.mkEnableOption "claw.free OpenClaw bootstrap services";

    gatewayPort = lib.mkOption {
      type = lib.types.port;
      default = 18789;
      description = "Gateway port exposed for deployment health checks.";
    };

    defaultProvider = lib.mkOption {
      type = lib.types.str;
      default = "claude";
      description = "Fallback LLM provider used when metadata is missing.";
    };

    metadataHost = lib.mkOption {
      type = lib.types.str;
      default = "http://metadata.google.internal/computeMetadata/v1/instance/attributes";
      description = "GCE metadata endpoint used to fetch bot runtime configuration.";
    };
  };

  config = lib.mkIf cfg.enable {
    networking.firewall.allowedTCPPorts = [ cfg.gatewayPort ];

    # nix-ld provides /lib/ld-linux-x86-64.so.2 compatibility shim so
    # prebuilt npm native binaries (node-llama-cpp etc.) can find glibc.
    programs.nix-ld.enable = true;

    environment.systemPackages = with pkgs; [
      curl
      git
      jq
      nodejs_22
    ];

    environment.etc."openclaw/provider/server.js".text = builtins.readFile "${clawfreeRoot}/provider/server.js";
    environment.etc."openclaw/provider/package.json".text = builtins.readFile "${clawfreeRoot}/provider/package.json";
    environment.etc."openclaw/skill".source = "${clawfreeRoot}/skill";

    systemd.tmpfiles.rules = [
      "d ${stateDir} 0755 root root -"
      "d ${stateDir}/.npm-cache 0755 root root -"
      "d ${npmPrefix} 0755 root root -"
      "d ${homeDir} 0755 root root -"
      "d ${configDir} 0755 root root -"
      "d ${workspaceDir} 0755 root root -"
      "d ${providerDir} 0755 root root -"
    ];

    systemd.services.openclaw-setup = {
      description = "Prepare OpenClaw runtime state from VM metadata";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      before = [ "claw-free-provider.service" "openclaw-gateway.service" "openclaw-ai-tools.service" ];

      path = with pkgs; [
        bash
        coreutils
        curl
        git
        gnugrep
        jq
        nodejs_22
      ];

      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
      };

      script = ''
        set -euo pipefail
        SETUP_STATUS_REPORTED=0

        retry() {
          local attempts="$1"
          shift

          local try=1
          while true; do
            if "$@"; then
              return 0
            fi

            if [ "$try" -ge "$attempts" ]; then
              return 1
            fi

            sleep $((try * 2))
            try=$((try + 1))
          done
        }

        metadata_get() {
          local key="$1"
          local default_value="$2"
          local value=""

          if value=$(curl -fsS -m 2 "${cfg.metadataHost}/$key" -H "Metadata-Flavor: Google" 2>/dev/null); then
            echo "$value"
            return 0
          fi

          echo "$default_value"
        }

        publish_setup_state() {
          local value="$1"
          ${pkgs.curl}/bin/curl -fsS -m 2 -X PUT "${guestAttributeSetupUrl}" \
            -H "Metadata-Flavor: Google" \
            --data-binary "$value" >/dev/null 2>&1 || true
        }

        mark_setup_failed() {
          local reason="$1"
          publish_setup_state "failed:$reason"
          SETUP_STATUS_REPORTED=1
        }

        trap 'if [ "$SETUP_STATUS_REPORTED" -eq 0 ]; then mark_setup_failed "openclaw-setup-error"; fi' ERR

        TELEGRAM_TOKEN="$(metadata_get TELEGRAM_TOKEN "")"
        if [ -z "$TELEGRAM_TOKEN" ]; then
          echo "Missing TELEGRAM_TOKEN metadata, aborting setup."
          mark_setup_failed "missing-telegram-token"
          exit 1
        fi

        LLM_PROVIDER="$(metadata_get LLM_PROVIDER "${cfg.defaultProvider}")"

        install -d "${stateDir}" "${stateDir}/.npm-cache" "${npmPrefix}" \
          "${homeDir}" "${configDir}" "${workspaceDir}" "${providerDir}"

        cp /etc/openclaw/provider/server.js "${providerDir}/server.js"
        cp /etc/openclaw/provider/package.json "${providerDir}/package.json"

        rm -rf "${configDir}/skills/claw-free"
        install -d "${configDir}/skills"
        cp -R /etc/openclaw/skill "${configDir}/skills/claw-free"

        if [ ! -x "${npmPrefix}/bin/openclaw" ]; then
          retry 3 env npm_config_cache="${stateDir}/.npm-cache" \
            ${pkgs.nodejs_22}/bin/npm install -g --ignore-scripts --prefix "${npmPrefix}" openclaw@latest
        fi

        ${pkgs.jq}/bin/jq -n \
          --arg telegramToken "$TELEGRAM_TOKEN" \
          --arg workspace "${workspaceDir}" \
          '{
            gateway: {
              mode: "local"
            },
            agents: {
              defaults: {
                workspace: $workspace,
                model: {
                  primary: "claw-free/setup"
                }
              }
            },
            channels: {
              telegram: {
                enabled: true,
                botToken: $telegramToken,
                dmPolicy: "open",
                allowFrom: ["*"],
                groupPolicy: "allowlist"
              }
            },
            models: {
              mode: "merge",
              providers: {
                "claw-free": {
                  baseUrl: "http://localhost:3456/v1",
                  apiKey: "local",
                  api: "openai-completions",
                  models: [
                    {
                      id: "setup",
                      name: "claw.free Setup",
                      reasoning: false,
                      input: ["text"],
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      contextWindow: 128000,
                      maxTokens: 4096
                    }
                  ]
                }
              }
            }
          }' > "${configPath}"
        chmod 600 "${configPath}"

        printf 'LLM_PROVIDER=%s\n' "$LLM_PROVIDER" > "${providerEnvPath}"
        chmod 600 "${providerEnvPath}"

        touch "${setupMarker}"
        publish_setup_state "ready"
        SETUP_STATUS_REPORTED=1
      '';
    };

    systemd.services.claw-free-provider = {
      description = "claw.free bootstrap LLM provider";
      wantedBy = [ "multi-user.target" ];
      requires = [ "openclaw-setup.service" ];
      after = [ "openclaw-setup.service" "network-online.target" ];
      wants = [ "network-online.target" ];

      environment = {
        OPENCLAW_CONFIG_PATH = configPath;
        PATH = lib.mkForce "${npmPrefix}/bin:/run/current-system/sw/bin";
      };

      serviceConfig = {
        Type = "simple";
        WorkingDirectory = providerDir;
        ExecStart = "${pkgs.nodejs_22}/bin/node ${providerDir}/server.js";
        EnvironmentFile = "-${providerEnvPath}";
        Restart = "on-failure";
        RestartSec = 5;
      };
    };

    systemd.services.openclaw-gateway = {
      description = "OpenClaw gateway";
      wantedBy = [ "multi-user.target" ];
      requires = [ "openclaw-setup.service" "claw-free-provider.service" ];
      after = [ "openclaw-setup.service" "claw-free-provider.service" "network-online.target" ];
      wants = [ "network-online.target" ];

      environment = {
        HOME = homeDir;
        OPENCLAW_CONFIG_PATH = configPath;
        PATH = lib.mkForce "${npmPrefix}/bin:/run/current-system/sw/bin";
      };

      serviceConfig = {
        Type = "simple";
        WorkingDirectory = homeDir;
        ExecStart = "${npmPrefix}/bin/openclaw gateway --bind lan --port ${toString cfg.gatewayPort}";
        Restart = "always";
        RestartSec = 5;
      };
    };

    systemd.services.openclaw-ai-tools = {
      description = "Install Claude/Codex/Gemini CLIs";
      wantedBy = [ "multi-user.target" ];
      after = [ "openclaw-setup.service" "network-online.target" ];
      wants = [ "network-online.target" ];

      serviceConfig = {
        Type = "oneshot";
      };

      script = ''
        set -euo pipefail

        if [ -f "${aiToolsMarker}" ]; then
          exit 0
        fi

        if ! env npm_config_cache="${stateDir}/.npm-cache" ${pkgs.nodejs_22}/bin/npm install -g --prefix "${npmPrefix}" \
          @anthropic-ai/claude-code @openai/codex @google/gemini-cli; then
          echo "AI CLI installation failed; continuing without blocking gateway startup."
          exit 0
        fi

        touch "${aiToolsMarker}"
      '';
    };
  };
}
