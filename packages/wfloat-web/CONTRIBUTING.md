# Contributing

## Local package smoke test

```sh
yarn build
python3 -m http.server 8000
```

## Maintainer note

TODO: Add a producer backpressure snippet that tells your worker to pause synthesis when bufferedSeconds > X and resume when it falls below Y. That preserves all audio and avoids runaway RAM.
