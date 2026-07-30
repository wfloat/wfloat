# Contributing

## Local package smoke test

```sh
npm install
npm run build:wasm
npm run build:dev
python3 -m http.server 4173
```

`npm run build` creates the release package and requires
`WFLOAT_WEB_SHERPA_WASM_URL` and `WFLOAT_WEB_LLAMA_WASM_URL`. CI obtains both
URLs from the authenticated Web WASM publishing endpoint.

## Maintainer note

TODO: Add a producer backpressure snippet that tells your worker to pause synthesis when bufferedSeconds > X and resume when it falls below Y. That preserves all audio and avoids runaway RAM.
