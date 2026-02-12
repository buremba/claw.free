{ config, lib, pkgs, clawfreeRoot, ... }:
let
  cfg = config.services.clawFree;

  stateDir = "/var/lib/openclaw";
  homeDir = "${stateDir}/home";
  configDir = "${homeDir}/.openclaw";
  configPath = "${configDir}/openclaw.json";
  workspaceDir = "${configDir}/workspace";
  setupMarker = "${stateDir}/.setup-complete";
  guestAttributeSetupUrl = "http://metadata.google.internal/computeMetadata/v1/instance/guest-attributes/openclaw/setup";
  aiCliBundle = pkgs.buildNpmPackage {
    pname = "openclaw-ai-tools";
    version = "1.0.0";
    src = "${clawfreeRoot}/infra/nixos/base/ai-tools";
    npmDepsHash = "sha256-QH0nFKOlwjMaAhCq7oRv7WEvKIG5zBd6p1ViYJNYFxY=";
    nodejs = pkgs.nodejs_22;
    makeCacheWritable = true;
    npmFlags = [ "--ignore-scripts" ];
    nativeBuildInputs = [
      pkgs.pkg-config
    ];
    buildInputs = [
      pkgs.libsecret
    ];
    dontNpmBuild = true;
    installPhase = ''
      runHook preInstall

      mkdir -p "$out/lib" "$out/bin"
      cp -r node_modules "$out/lib/"
      ln -s "$out/lib/node_modules/.bin/claude" "$out/bin/claude"
      ln -s "$out/lib/node_modules/.bin/codex" "$out/bin/codex"
      ln -s "$out/lib/node_modules/.bin/gemini" "$out/bin/gemini"
      ln -s "$out/lib/node_modules/.bin/openclaw" "$out/bin/openclaw"

      runHook postInstall
    '';
  };
  clawPath = "${aiCliBundle}/bin:/run/current-system/sw/bin";
in
{
  options.services.clawFree = {
    enable = lib.mkEnableOption "claw.free OpenClaw bootstrap services";

    gatewayPort = lib.mkOption {
      type = lib.types.port;
      default = 18789;
      description = "Gateway port exposed for deployment health checks.";
    };

    metadataHost = lib.mkOption {
      type = lib.types.str;
      default = "http://metadata.google.internal/computeMetadata/v1/instance/attributes";
      description = "GCE metadata endpoint used to fetch bot runtime configuration.";
    };
  };

  config = lib.mkIf cfg.enable {
    networking.firewall.allowedTCPPorts = [ cfg.gatewayPort ];

    programs.nix-ld.enable = true;

    environment.systemPackages = with pkgs; [
      curl
      git
      jq
      nodejs_22
      python3
      gcc
      gnumake
      aiCliBundle
    ];

    environment.etc."openclaw/skill".source = "${clawfreeRoot}/skill";

    systemd.tmpfiles.rules = [
      "d ${stateDir} 0755 root root -"
      "d ${homeDir} 0755 root root -"
      "d ${configDir} 0755 root root -"
      "d ${workspaceDir} 0755 root root -"
    ];

    systemd.services.openclaw-setup = {
      description = "Prepare OpenClaw runtime state from VM metadata";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      before = [ "openclaw-gateway.service" ];

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

        install -d "${stateDir}" "${homeDir}" "${configDir}" "${workspaceDir}"

        # Install skills (management + onboarding)
        rm -rf "${configDir}/skills/claw-free"
        install -d "${configDir}/skills"
        cp -R /etc/openclaw/skill "${configDir}/skills/claw-free"

        # Always start with bootstrap provider — users configure their real LLM
        # through the dummy model provider's interactive setup flow in the bot chat
        MODEL_CONFIG=$(${pkgs.jq}/bin/jq -n '{
          mode: "merge",
          providers: {
            "claw-free": {
              baseUrl: "http://localhost:3456/v1",
              apiKey: "local",
              api: "openai-completions",
              models: [{
                id: "setup",
                name: "claw.free Setup",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 4096
              }]
            }
          }
        }')
        PRIMARY_MODEL="claw-free/setup"

        ${pkgs.jq}/bin/jq -n \
          --arg telegramToken "$TELEGRAM_TOKEN" \
          --arg workspace "${workspaceDir}" \
          --arg primaryModel "$PRIMARY_MODEL" \
          --argjson models "$MODEL_CONFIG" \
          '{
            gateway: {
              mode: "local"
            },
            agents: {
              defaults: {
                workspace: $workspace,
                model: {
                  primary: $primaryModel
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
            models: $models
          }' > "${configPath}"
        chmod 600 "${configPath}"

        touch "${setupMarker}"
        publish_setup_state "ready"
        SETUP_STATUS_REPORTED=1
      '';
    };

    # Relay tunnel client — connects outbound to Railway relay server via WebSocket.
    # Receives Telegram webhooks through the tunnel, forwards to localhost:18789.
    # No inbound ports needed, no Tailscale, no special network capabilities.
    systemd.services.openclaw-relay = {
      description = "WebSocket relay tunnel to Railway";
      wantedBy = [ "multi-user.target" ];
      after = [ "openclaw-setup.service" "network-online.target" "openclaw-gateway.service" ];
      wants = [ "network-online.target" ];

      path = with pkgs; [ curl nodejs_22 ];

      serviceConfig = {
        Type = "simple";
        Restart = "always";
        RestartSec = 5;
        # Read relay credentials from metadata at start
        ExecStartPre = "${pkgs.writeShellScript "fetch-relay-env" ''
          RELAY_URL="$(curl -fsS -m 5 "${cfg.metadataHost}/RELAY_URL" -H "Metadata-Flavor: Google" 2>/dev/null || true)"
          RELAY_TOKEN="$(curl -fsS -m 5 "${cfg.metadataHost}/RELAY_TOKEN" -H "Metadata-Flavor: Google" 2>/dev/null || true)"
          mkdir -p /run/openclaw
          echo "RELAY_URL=$RELAY_URL" > /run/openclaw/relay.env
          echo "RELAY_TOKEN=$RELAY_TOKEN" >> /run/openclaw/relay.env
        ''}";
        EnvironmentFile = "-/run/openclaw/relay.env";
        ExecStart = "${pkgs.nodejs_22}/bin/node /etc/openclaw/relay-client/tunnel.mjs";
      };
    };

    environment.etc."openclaw/relay-client/tunnel.mjs".source = "${clawfreeRoot}/infra/relay-client/tunnel.mjs";

    systemd.services.openclaw-gateway = {
      description = "OpenClaw gateway";
      wantedBy = [ "multi-user.target" ];
      requires = [ "openclaw-setup.service" ];
      after = [ "openclaw-setup.service" "network-online.target" ];
      wants = [ "network-online.target" ];

      environment = {
        HOME = homeDir;
        OPENCLAW_CONFIG_PATH = configPath;
        OPENCLAW_GATEWAY_TOKEN = "claw-free-local-token";
        PATH = lib.mkForce clawPath;
      };

      serviceConfig = {
        Type = "simple";
        WorkingDirectory = homeDir;
        ExecStart = "${aiCliBundle}/bin/openclaw gateway --bind lan --port ${toString cfg.gatewayPort}";
        Restart = "always";
        RestartSec = 5;
      };
    };
  };
}
