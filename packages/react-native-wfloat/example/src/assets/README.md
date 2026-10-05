# Speech test fixture

`french-eight-seconds.wav` is synthetic French speech generated with Piper
`rhasspy/piper-fr_FR-siwis-medium`, speaker 0, saying:

> Bonjour, ceci est un test de voix.

The 50,701-sample output at 22,050 Hz is padded with silence to eight seconds.
This is a functional test input, not a natural-speech accuracy benchmark.

The [upstream model card](https://huggingface.co/rhasspy/piper-voices/blob/main/fr/fr_FR/siwis/medium/MODEL_CARD)
credits the SIWIS dataset under CC-BY 4.0. This attribution describes the model's
training-data provenance, not a separate claim about licensing generated audio.

SHA-256: `f44457785bf818664ed3db83d9584d334abe7457a8424fd2b9a20a2e055adfcb`.
