#!/bin/sh
# Harness probe (2026-11-13): each harness runs once, offline, against mock.py, in a container with a read-only root,
# a 256 MiB tmpfs home and /tmp, no capabilities, 1 CPU, 1 GiB, on an internal network that reaches only the mock.
# The prompt asks for the Flux tool; the mock model calls it and then answers. Output, stderr and /usr/bin/time -v go to
# $OUT/<harness>.*; the mock's journal is $OUT/journal.jsonl.
set -u
IMG=flux-harness-probe:2026-11-13
OUT=${OUT:-$(pwd)/out}
mkdir -p "$OUT" && chmod 777 "$OUT"
NET=flux-harness-probe
docker network create --internal $NET >/dev/null 2>&1 || true
docker rm -f flux-harness-mock >/dev/null 2>&1
docker run -d --name flux-harness-mock --network $NET --network-alias mock -v "$OUT":/out:z \
  -v "$(dirname "$0")/mock.py":/mock.py:ro,z python:3.12-slim python3 -u /mock.py /out >/dev/null
sleep 2
PROMPT='Call the flux_echo tool with the text hello, then report what it returned.'
MCP=http://mock:8090/mcp
run() { # name, shell script
  name=$1; shift
  case " ${ONLY:-$name} " in *" $name "*) ;; *) return ;; esac
  echo "== $name"
  docker run --rm --network $NET --read-only --tmpfs /home/agent:rw,size=256m,uid=20001,gid=20001,exec \
    --tmpfs /tmp:rw,size=256m,exec --cap-drop ALL --security-opt no-new-privileges --cpus 1 --memory 1g --pids-limit 512 \
    -e HOME=/home/agent -e PROMPT="$PROMPT" -e MCP=$MCP -e OPENAI_API_KEY=sk-probe -e NO_COLOR=1 \
    -e DO_NOT_TRACK=1 -e DISABLE_TELEMETRY=1 -v "$OUT":/out:z $IMG sh -c "
      start=\$(date +%s.%N)
      $*
      end=\$(date +%s.%N); echo \"wall \$(echo \"\$end - \$start\" | sed 's/ //g')\" >> /out/$name.wall
    " > "$OUT/$name.stdout" 2> "$OUT/$name.stderr"
  echo "exit $?" > "$OUT/$name.exit"
  tail -c 600 "$OUT/$name.stdout"; echo
}

T='/usr/bin/time -v -o /out/$NAME.time timeout 120'

# pi 1.5.2 — models.json custom endpoint, mcp.json HTTP server with a bearer header, JSON mode.
run pi "NAME=pi; mkdir -p ~/.pi/agent && cat > ~/.pi/agent/models.json <<J
{\"providers\":{\"probe\":{\"baseUrl\":\"http://mock:8080/v1\",\"api\":\"openai-completions\",\"apiKey\":\"sk-probe\",\"models\":[{\"id\":\"mock-model\"}]}}}
J
cat > ~/.pi/agent/mcp.json <<J
{\"mcpServers\":{\"flux\":{\"url\":\"\$MCP\",\"headers\":{\"Authorization\":\"Bearer run-token\"},\"exposure\":\"direct\"}}}
J
$T pi --mode json --no-session --model probe/mock-model \"\$PROMPT\""

# opencode 2.3.0 — custom openai-compatible provider and a remote MCP server, JSON format, private server.
run opencode "NAME=opencode; mkdir -p ~/.config/opencode && cat > ~/.config/opencode/opencode.json <<J
{\"providers\":{\"probe\":{\"package\":\"@opencode/ai/providers/openai-compatible\",\"name\":\"Probe\",\"settings\":{\"baseURL\":\"http://mock:8080/v1\",\"apiKey\":\"sk-probe\"},\"models\":{\"mock-model\":{\"name\":\"mock\"}}}},
 \"provider\":{\"probe\":{\"npm\":\"@ai-sdk/openai-compatible\",\"name\":\"Probe\",\"options\":{\"baseURL\":\"http://mock:8080/v1\",\"apiKey\":\"sk-probe\"},\"models\":{\"mock-model\":{\"name\":\"mock\"}}}},
 \"mcp\":{\"servers\":{\"flux\":{\"type\":\"remote\",\"url\":\"\$MCP\",\"oauth\":false,\"codemode\":false,\"headers\":{\"Authorization\":\"Bearer run-token\"}}}},
 \"autoupdate\":false,\"share\":\"disabled\"}
J
$T opencode run --standalone --format json --auto --model probe/mock-model \"\$PROMPT\""

# goose 1.59.0 — openai provider at the mock, the MCP server as a streamable HTTP extension in config.yaml.
run goose "NAME=goose; mkdir -p ~/.config/goose && cat > ~/.config/goose/config.yaml <<J
GOOSE_PROVIDER: openai
GOOSE_MODEL: mock-model
OPENAI_HOST: http://mock:8080
OPENAI_BASE_PATH: v1/chat/completions
GOOSE_MODE: auto
GOOSE_TELEMETRY_ENABLED: false
extensions:
  flux:
    enabled: true
    type: streamable_http
    name: flux
    uri: \$MCP
    headers:
      Authorization: Bearer run-token
    timeout: 60
J
$T goose run --no-session --output-format stream-json -t \"\$PROMPT\""

# crush 0.101.0 — openai-compat provider, http MCP server; no JSON output mode exists for run.
run crush "NAME=crush; mkdir -p ~/.config/crush && cat > ~/.config/crush/crush.json <<J
{\"providers\":{\"probe\":{\"type\":\"openai-compat\",\"base_url\":\"http://mock:8080/v1\",\"api_key\":\"sk-probe\",\"models\":[{\"id\":\"mock-model\",\"name\":\"mock\",\"context_window\":128000,\"default_max_tokens\":4096}]}},
 \"models\":{\"large\":{\"model\":\"mock-model\",\"provider\":\"probe\"},\"small\":{\"model\":\"mock-model\",\"provider\":\"probe\"}},
 \"mcp\":{\"flux\":{\"type\":\"http\",\"url\":\"\$MCP\",\"headers\":{\"Authorization\":\"Bearer run-token\"}}},
 \"options\":{\"disable_metrics\":true}}
J
$T crush run -q -y -m probe/mock-model \"\$PROMPT\""

# Qwen Code 0.27.3 — OpenAI auth type at the mock, inline MCP config, stream-json.
run qwen "NAME=qwen; mkdir -p ~/.qwen && echo '{\"tools\":{\"toolSearch\":{\"threshold\":100000}}}' > ~/.qwen/settings.json; $T qwen --auth-type openai --openai-base-url http://mock:8080/v1 --openai-api-key sk-probe -m mock-model \
  --mcp-config '{\"mcpServers\":{\"flux\":{\"httpUrl\":\"'\$MCP'\",\"headers\":{\"Authorization\":\"Bearer run-token\"}}}}' \
  --approval-mode yolo -o stream-json \"\$PROMPT\""

# Claude Code 2.1.323 — API-key mode at an Anthropic-format endpoint (the mock), Flux as the only MCP server.
run claude "NAME=claude; $T env ANTHROPIC_BASE_URL=http://mock:8080 ANTHROPIC_API_KEY=sk-ant-probe DISABLE_AUTOUPDATER=1 ENABLE_TOOL_SEARCH=false \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 claude -p --output-format stream-json --verbose --model claude-sonnet-4-5 \
  --strict-mcp-config --mcp-config '{\"mcpServers\":{\"flux\":{\"type\":\"http\",\"url\":\"'\$MCP'\",\"headers\":{\"Authorization\":\"Bearer run-token\"}}}}' \
  --allowedTools mcp__flux__flux_echo --no-session-persistence \"\$PROMPT\""

# Claude Code 2.1.323 as #1437 would run it: its file and shell tools only, Flux as the only MCP server.
run claude-1437 "NAME=claude-1437; $T env ANTHROPIC_BASE_URL=http://mock:8080 ANTHROPIC_API_KEY=sk-ant-probe DISABLE_AUTOUPDATER=1 ENABLE_TOOL_SEARCH=false \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 claude -p --output-format stream-json --verbose --model claude-sonnet-4-5 \
  --tools Bash,Read,Write,Edit,Glob,Grep --strict-mcp-config --mcp-config '{\"mcpServers\":{\"flux\":{\"type\":\"http\",\"url\":\"'\$MCP'\",\"headers\":{\"Authorization\":\"Bearer run-token\"}}}}' \
  --allowedTools mcp__flux__flux_echo,Bash,Read,Write,Edit,Glob,Grep --permission-mode dontAsk --no-session-persistence \"\$PROMPT\""

# Codex 0.169.0 — a custom Responses provider at the mock (Codex speaks only the Responses API), Flux as an HTTP MCP server.
run codex "NAME=codex; mkdir -p ~/.codex && cat > ~/.codex/config.toml <<J
model = \"mock-model\"
model_provider = \"probe\"
[analytics]
enabled = false
[model_providers.probe]
name = \"probe\"
base_url = \"http://mock:8080/v1\"
env_key = \"OPENAI_API_KEY\"
wire_api = \"responses\"
[mcp_servers.flux]
url = \"\$MCP\"
http_headers = { Authorization = \"Bearer run-token\" }
J
$T codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox \"\$PROMPT\""

docker rm -f flux-harness-mock >/dev/null
