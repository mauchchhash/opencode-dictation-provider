# OpenCode Dictation Provider

An OpenAI-compatible local adapter for dictation cleanup. It accepts OpenWhispr-compatible chat-completion requests on loopback, sends the dictated text to a local OpenCode server and its restricted `dictation-cleaner` agent, then returns only the cleaned text.

No dictation request is sent to a remote HTTP endpoint by this adapter. The model selected in OpenWhispr is sent to OpenCode, which uses that model provider according to your OpenCode configuration.

## Requirements

- Linux with `systemd --user`
- Node.js 22 or newer, including the `node` executable
- OpenCode installed and available as `opencode`
- An OpenCode provider/account configured for every model you intend to use
- OpenWhispr, or another OpenAI-compatible client

Verify the executables before continuing:

```sh
node --version
opencode --version
command -v node
command -v opencode
```

Install and authenticate OpenCode according to its official documentation before enabling the services. Confirm the models available to your account with:

```sh
opencode models
```

## What Is Versioned

The repository contains templates for every file installed outside the checkout:

| Template | Installed location |
| --- | --- |
| `examples/opencode-dictation-provider.env.example` | `~/.config/opencode-dictation-provider/env` |
| `examples/dictation-cleaner.md` | `~/.config/opencode/agents/dictation-cleaner.md` |
| `examples/opencode-dictation-opencode.service` | `~/.config/systemd/user/opencode-dictation-opencode.service` |
| `examples/opencode-dictation-provider.service` | `~/.config/systemd/user/opencode-dictation-provider.service` |

The installed environment file contains secrets and is intentionally not tracked. Do not commit it.

## Installation

These steps use `~/.local/src/opencode-dictation-provider` as the checkout location because the provider service template uses that path. Choose another location only if you update `WorkingDirectory` in the provider service file.

### 1. Clone and test

```sh
mkdir -p ~/.local/src
git clone https://github.com/YOUR-ACCOUNT/opencode-dictation-provider.git ~/.local/src/opencode-dictation-provider
cd ~/.local/src/opencode-dictation-provider
npm test
```

This project has no runtime npm dependencies. Node's built-in `fetch` and test runner are used.

### 2. Create the private environment file

```sh
mkdir -p ~/.config/opencode-dictation-provider
cp examples/opencode-dictation-provider.env.example ~/.config/opencode-dictation-provider/env
chmod 600 ~/.config/opencode-dictation-provider/env
```

Edit `~/.config/opencode-dictation-provider/env` and replace both placeholder secrets. Generate distinct values with:

```sh
openssl rand -hex 32
```

Keep `DICTATION_DEFAULT_MODEL` inside `DICTATION_MODELS`. Every entry in `DICTATION_MODELS` must use the `provider/model` form and be available through your OpenCode configuration. Remove models you do not use rather than assuming the example list is available to your account.

`DICTATION_DEBUG=false` is the privacy-safe default: the journal records only the completion ID and selected model. Setting it to `true` writes the input and cleaned dictation text to the journal.

### 3. Install the cleanup agent

```sh
mkdir -p ~/.config/opencode/agents
cp examples/dictation-cleaner.md ~/.config/opencode/agents/dictation-cleaner.md
```

The agent deliberately returns only cleaned dictation and instructs OpenCode not to use tools. Do not add a fixed `model` setting to this agent: the adapter supplies the model selected by the client.

### 4. Install systemd user services

```sh
mkdir -p ~/.config/systemd/user
cp examples/opencode-dictation-opencode.service ~/.config/systemd/user/
cp examples/opencode-dictation-provider.service ~/.config/systemd/user/
```

If `command -v node` or `command -v opencode` is not available to systemd, replace the corresponding `/usr/bin/env ...` command in the installed service file with the absolute command path printed earlier. This is commonly required when Node is installed through `nvm`.

If you cloned to a location other than `~/.local/src/opencode-dictation-provider`, update `WorkingDirectory` in `~/.config/systemd/user/opencode-dictation-provider.service` to that absolute location.

Enable and start both services:

```sh
systemctl --user daemon-reload
systemctl --user enable --now opencode-dictation-opencode.service
systemctl --user enable --now opencode-dictation-provider.service
```

User services start after login. To keep them running while you are logged out, enable lingering once:

```sh
loginctl enable-linger "$USER"
```

### 5. Verify locally

Check service status:

```sh
systemctl --user status opencode-dictation-opencode.service opencode-dictation-provider.service
```

Check the adapter health endpoint:

```sh
curl http://127.0.0.1:11435/health
```

It should return `{"status":"ok"}`. List the client-visible models using the `DICTATION_API_KEY` from the private environment file:

```sh
curl -H "Authorization: Bearer YOUR_DICTATION_API_KEY" http://127.0.0.1:11435/v1/models
```

Test a cleanup request:

```sh
curl --request POST http://127.0.0.1:11435/v1/chat/completions \
  --header "Authorization: Bearer YOUR_DICTATION_API_KEY" \
  --header "Content-Type: application/json" \
  --data '{"model":"opencode/deepseek-v4-flash-free","messages":[{"role":"user","content":"um hello there"}]}'
```

Use a model that is actually present in your `DICTATION_MODELS` list.

## OpenWhispr Configuration

Configure an OpenAI-compatible provider with:

| Setting | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:11435/v1` |
| API key | Value of `DICTATION_API_KEY` |
| Model | Select one returned by the provider's model-refresh action |

The adapter rejects models not explicitly listed in `DICTATION_MODELS`. It does not support streaming.

## Operations

```sh
# View status
systemctl --user status opencode-dictation-opencode.service opencode-dictation-provider.service

# Restart after changing the environment file, agent, or service files
systemctl --user restart opencode-dictation-opencode.service opencode-dictation-provider.service

# Follow adapter logs
journalctl --user -u opencode-dictation-provider.service -f -o cat

# Follow OpenCode server logs
journalctl --user -u opencode-dictation-opencode.service -f -o cat
```

After changing either `.service` file, run `systemctl --user daemon-reload` before restarting it. After changing `DICTATION_DEBUG`, the model list, keys, or other environment variables, restart the provider because it reads its configuration at startup.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Provider service repeatedly restarts | Run `journalctl --user -u opencode-dictation-provider.service -n 100 -o cat`; ensure both required secrets are set and the Node path is valid. |
| Cleanup returns a 502 error | Check the OpenCode service journal and confirm OpenCode authentication and the selected model work outside this adapter. |
| OpenWhispr cannot list models | Confirm the base URL includes `/v1`, the API key is correct, and `curl` to `/v1/models` succeeds. |
| A model is rejected | Add its exact `provider/model` ID to `DICTATION_MODELS`, ensure it is available in OpenCode, then restart the provider. |
| systemd cannot find Node or OpenCode | Use absolute executable paths in the installed service files, then daemon-reload and restart. |

## Security Notes

- Both services bind to `127.0.0.1`; do not expose them through a reverse proxy without adding proper access controls.
- Keep `~/.config/opencode-dictation-provider/env` mode `600` and out of version control.
- Leave `DICTATION_DEBUG=false` unless recording dictated text in the system journal is intentional.
- The OpenWhispr API key protects the adapter endpoint. The OpenCode server password protects communication between the adapter and local OpenCode server.
