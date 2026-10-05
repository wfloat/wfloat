# Gemma 3 1B Instruct assets

Public model ID: `google/gemma-3-1b-it`. The initial artifact is Q4_K_M from
`ggml-org/gemma-3-1b-it-GGUF`, revision
`f9c28bcd85737ffc5aef028638d3341d49869c27`.

The model is stored as two native GGUF shards, not transport fragments. Both
must be downloaded and verified. Web/Python stage the canonical sibling names;
React Native supplies an ordered path list to llama.cpp. Never concatenate these
shards. Tokenizer and chat-template metadata are embedded in the first shard.

`manifest.json` records the source hash, approved public asset paths, exact sizes,
and SHA-256 values. Packaging checks compared all 340 tensor names, shapes, types
and bytes (including padding) against the unsplit source, and preserved original
metadata. Wfloat did not fine-tune the weights.

The accompanying Gemma terms, prohibited-use policy, NOTICE and provenance are
model assets and are downloaded alongside the weights. The HTML documents are
snapshots of Google's official pages, not amended terms. They apply to the model;
the Wfloat SDK's software license is unchanged. Applications distributing Gemma
must satisfy the model's downstream obligations.

Inference verification is recorded separately from this immutable publication
manifest; its `inferenceTested: false` describes the prepublication preparation.

The initial integration uses a 2,048-token context and the embedded template.
Text generation, system-message/history continuation, and constrained JSON have
been exercised. This registration does not advertise tool calling or reasoning
capabilities; the tool probe did not produce a tool call.
