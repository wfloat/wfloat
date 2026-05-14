# Vendored Backends

This directory contains upstream-derived runtime code that Wfloat vendors into
the monorepo instead of using git submodules.

## Rules

- keep upstream project names
- keep backends separate from each other
- integrate through Wfloat-owned layers instead of blending backend internals
- document source and update strategy when a new backend is imported

## Current Entries

- `sherpa-onnx`
- `llama.cpp`
