# @vibecontrols/vibe-plugin-agent-backup

<!-- VIBECONTROLS_OSS_BODY_START -->

> Back up Skalex-backed agent state to S3 or any custom storage — restore on demand.

## Install

```bash
vibe plugin install @vibecontrols/vibe-plugin-agent-backup
```

Or install the npm package directly into an existing project that hosts the VibeControls agent:

```bash
bun add @vibecontrols/vibe-plugin-agent-backup
# or
npm install @vibecontrols/vibe-plugin-agent-backup
```

## How it works

**Agent** plugins extend the agent itself with cross-cutting capabilities (state backup / restore, AI-provider configuration, etc.). They are not tied to a single meta plugin contract.

## More

- npm: <https://www.npmjs.com/package/@vibecontrols/vibe-plugin-agent-backup>
- Source: <https://github.com/algoshred/vibe-plugin-agent-backup>
- Plugin contract / SDK: <https://github.com/algoshred/vibecontrols-plugin-sdk>
- Plugin catalogue: <https://vibecontrols.com/plugins/agent-backup>

<!-- VIBECONTROLS_OSS_BODY_END -->

<!-- VIBECONTROLS_OSS_FOOTER_START -->

---

## About VibeControls

**VibeControls** is the agentic engineering mission control for AI-native teams. Vibe-plugins extend the VibeControls agent with new providers, tools, sessions, tunnels, storage backends, and security stages.

- Website: <https://vibecontrols.com>
- Documentation: <https://docs.vibecontrols.com>
- Plugin SDK: <https://github.com/algoshred/vibecontrols-plugin-sdk>
- All plugins: <https://github.com/algoshred?q=vibe-plugin-&type=all>

## License

Released under the [MIT License](./LICENSE).

Copyright (c) 2026 Burdenoff Consultancy Services Private Limited, Algoshred Technologies Private Limited, and all its sister companies.

Maintainer: **Vignesh T.V** — <https://github.com/tvvignesh>

**Note**: this plugin is open source under MIT. The `@vibecontrols/agent` runtime that loads and orchestrates plugins is **closed source** and proprietary to Burdenoff Consultancy Services Pvt. Ltd. If you want a fully self-hostable agent, please open an issue or contact the maintainer.

<!-- VIBECONTROLS_OSS_FOOTER_END -->
