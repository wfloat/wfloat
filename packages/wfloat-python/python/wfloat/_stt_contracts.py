"""Internal option contracts for the published speech recognition models."""

import re

MULTILINGUAL_WHISPER = frozenset({
    'openai/whisper-tiny', 'openai/whisper-base', 'openai/whisper-small',
})
WHISPER_MODELS = MULTILINGUAL_WHISPER | {'openai/whisper-tiny-en'}
MOONSHINE_V2 = 'moonshine-ai/moonshine-base'
ZIPFORMER_LANGUAGES = {
    'k2-fsa/streaming-zipformer-en': frozenset({'en'}),
    'shaojieli/streaming-zipformer-fr': frozenset({'fr'}),
    'k2-fsa/streaming-zipformer-zh-en': frozenset({'zh', 'en'}),
}
# Matches GetAllWhisperLanguageCodes in the vendored Sherpa Whisper config.
WHISPER_LANGUAGES = frozenset('''
hi cy oc so fr az eu ba no as nl bn es ml km mk sq mt et ms tr bg ps br ht tt tk
la de ur ro fa uk mg lo sr yo id da pt nn sn sa sd gl ja pl ru ko ne kn zh be ca
el it hu lt ta is jw fi bo sv mi hr bs yi sk lv af vi ha mn cs sl pa su ka ln lb
sw en tl hy te he my haw fo kk si tg th ar am mr uz gu
'''.split())


def validate_options(model_id, language, task):
    if model_id == 'nvidia/parakeet-tdt-0.6b-v3':
        if language is not None:
            raise ValueError('Parakeet recognizes 25 languages automatically; forced language is unsupported')
    else:
        if language is not None:
            if not isinstance(language, str) or re.fullmatch(
                    r'[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*', language,
                    flags=re.IGNORECASE | re.ASCII) is None:
                raise ValueError('language must be a supported language code; omit it for automatic detection')
            language = re.split('[-_]', language.lower())[0]
        languages = (WHISPER_LANGUAGES if model_id in MULTILINGUAL_WHISPER
                     else ZIPFORMER_LANGUAGES.get(model_id, {'en'}))
        if language is not None and (not isinstance(language, str) or language not in languages):
            raise ValueError('Unsupported language for this recognition model')
    tasks = (None, 'transcribe', 'translate') if model_id in MULTILINGUAL_WHISPER else (None, 'transcribe')
    if task not in tasks:
        raise ValueError('Translation to English is supported only by multilingual Whisper')
    return language
