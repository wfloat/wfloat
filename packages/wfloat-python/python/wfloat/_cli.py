import argparse

from ._model import load


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="wfloat")
    subparsers = parser.add_subparsers(dest="command")

    generate = subparsers.add_parser("generate", help="Generate speech and write a WAV file.")
    generate.add_argument("--model", default="wfloat/wfloat-tts", help="Model name to load.")
    generate.add_argument("--text", required=True, help="Text to synthesize.")
    generate.add_argument("--out", required=True, help="Output WAV path.")
    generate.add_argument("--voice-id", default=None, help="Voice ID name or numeric SID.")
    generate.add_argument("--emotion", default=None, help="Emotion name.")
    generate.add_argument("--intensity", type=float, default=None, help="Emotion intensity.")
    generate.add_argument("--speed", type=float, default=None, help="Speech speed.")
    generate.add_argument(
        "--silence-padding-sec",
        type=float,
        default=None,
        help="Silence padding between generated sentence chunks.",
    )
    generate.add_argument(
        "--cache-dir",
        default=None,
        help="Optional override for the cache directory.",
    )
    generate.add_argument(
        "--force-download",
        action="store_true",
        help="Redownload model assets even if cached copies are present.",
    )

    return parser


def _maybe_parse_voice_id(value):
    if value is None:
        return None

    try:
        return int(value)
    except (TypeError, ValueError):
        return value


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command != "generate":
        parser.print_help()
        return 1

    model = load(
        args.model,
        cache_dir=args.cache_dir,
        force_download=args.force_download,
    )
    result = model.generate(
        text=args.text,
        voice_id=_maybe_parse_voice_id(args.voice_id),
        emotion=args.emotion,
        intensity=args.intensity,
        speed=args.speed,
        silence_padding_sec=args.silence_padding_sec,
    )
    result.audio.save(args.out)
    print(
        "Saved %s (duration=%.2fs, sample_rate=%d)"
        % (args.out, result.audio.duration_sec, result.audio.sample_rate)
    )
    return 0
