#!/usr/bin/env python3
"""Compare actual C++ helper/eSpeak output with phonemizer 3.3.0.
Requires an already compiled probe, existing eSpeak library/data, and the
reference phonemizer in the test environment; adds no runtime dependency.
"""
import argparse,json,os,pathlib,subprocess
from importlib.metadata import version
p=argparse.ArgumentParser();p.add_argument('probe');p.add_argument('library');p.add_argument('data_parent');a=p.parse_args()
os.environ['PHONEMIZER_ESPEAK_LIBRARY']=a.library
os.environ['ESPEAK_DATA_PATH']=a.data_parent
assert version('phonemizer')=='3.3.0', 'Pinned phonemizer 3.3.0 required'
from phonemizer.backend import EspeakBackend
from phonemizer.separator import Separator
backend=EspeakBackend('en-us',preserve_punctuation=True,with_stress=True)
texts=['Hello, this is a short speech test.', 'Café, version GPT three point five: one half!',
       'hello(world)', '(hello)—[world]… «yes» “no” {ok}!', 'hello ; : , . ! ? world',
       'café naïve façade jalapeño', 'bonjourこんにちは', 'hello_world', 'yes...no', '"hello"',
       'hello  world', '¡hello! ¿why?', 'hello—world', '(...)', 'hello\nworld', 'hello\tworld']
fixtures=json.loads((pathlib.Path(__file__).parent/'normalization-fixtures.json').read_text())['fixtures']
texts += [c for f in fixtures[:346] if 'chunks' in f for c in f['chunks'] if c]
payload=('\n'.join(' '.join(f'{ord(c):x}' for c in t) for t in texts)+'\n').encode()
lines=subprocess.check_output([a.probe,a.data_parent],input=payload).decode().splitlines()
assert len(lines)==len(texts)
failures=[]
for text,line in zip(texts,lines):
    actual=''.join(chr(int(c,16)) for c in line.split())
    expected=backend.phonemize([text],separator=Separator(phone='',word=' ',syllable=''),strip=True)[0]
    if actual!=expected:failures.append({'input':text,'expected':expected,'actual':actual})
print(json.dumps({'cases':len(texts),'failures':failures},ensure_ascii=False,indent=2))
raise SystemExit(bool(failures))
