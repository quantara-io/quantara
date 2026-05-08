---
name: demo
description: Open the Quantara auth demo site and API docs
disable-model-invocation: true
argument-hint: [page]
arguments: [page]
allowed-tools: Bash(open *) Bash(curl *)
---

# Open Quantara Demo

Open: $page (default: demo)

## Pages:

- **demo** → `https://d3tavvh2o76dc5.cloudfront.net/api/docs/demo`
- **docs** → `https://d3tavvh2o76dc5.cloudfront.net/api/docs`
- **api** → `https://d3tavvh2o76dc5.cloudfront.net/api/openapi.json`
- **health** → `https://d3tavvh2o76dc5.cloudfront.net/health`

```bash
open https://d3tavvh2o76dc5.cloudfront.net/api/docs/demo
```

If $page is "docs": `open https://d3tavvh2o76dc5.cloudfront.net/api/docs`
If $page is "api": `open https://d3tavvh2o76dc5.cloudfront.net/api/openapi.json`
If $page is "health": verify the health endpoint and report status.
