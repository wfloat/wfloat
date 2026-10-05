#!/usr/bin/env python3
"""No compilation. Verify generated patterns/data against pinned Python source.
Optionally compare an ALREADY BUILT text_probe with --probe PATH. This script
never builds anything and never loads an ONNX/eSpeak runtime.
"""
import argparse
import ast
import bisect
import hashlib
import json
import pathlib
import random
import re
import sys
import unittest
import unicodedata as ud
import subprocess
import math
import struct
from decimal import Decimal
import generate_frontend_data as g

HERE=pathlib.Path(__file__).resolve().parent
OUT=g.OUT

def array(name, path):
    source=path.read_text()
    body=re.search(r'\b'+name+r'\[\]\s*=\s*\{(.*?)\};',source,re.S)[1]
    return [int(x,0) for x in re.findall(r'-?0x[0-9a-f]+|-?\d+',body)]

def load_data():
    a=array('kFold',OUT/'offline-tts-kitten-text-data.h')
    fold=dict(zip(a[::2],a[1::2]))
    a=array('kRegexCode',OUT/'offline-tts-kitten-regex-data.h')
    code=[a[i:i+4] for i in range(0,len(a),4)]
    a=array('kRegexClasses',OUT/'offline-tts-kitten-regex-data.h')
    classes=[a[i:i+3] for i in range(0,len(a),3)]
    entries={name:int(value) for name,value in re.findall(r'int rx_(\w+) = (\d+)',(OUT/'offline-tts-kitten-regex-data.h').read_text())}
    return fold,code,classes,entries

FOLD,CODE,CLASSES,ENTRIES=load_data()

def match_at(entry,text,start):
    stack=[]; pc=entry; pos=start; caps=[None]*16
    while True:
        op,a,b,case=CODE[pc];pc+=1;ok=True
        if op==0:return caps
        if op in (1,2):
            ok=pos<len(text)
            if ok:
                c=ord(text[pos]);left=FOLD.get(c,c) if case else c;right=FOLD.get(a,a) if case else a
                ok=(left==right)!=(op==2)
            if ok:pos+=1
        elif op==3:
            ok=pos<len(text) and text[pos]!='\n'
            if ok:pos+=1
        elif op==4:
            ok=pos<len(text)
            if ok:
                c=text[pos];cp=ord(c);found=False
                for cat,lo,hi in CLASSES[a:a+b//2]:
                    value=FOLD.get(cp,cp) if case else cp
                    low=FOLD.get(lo,lo) if case else lo; high=FOLD.get(hi,hi) if case else hi
                    if cat==0:found |= low<=value<=high
                    elif cat==1:found |= c.isdecimal()
                    elif cat==2:found |= not c.isdecimal()
                    elif cat==3:found |= c.isspace()
                    elif cat==4:found |= not c.isspace()
                    elif cat==5:found |= c.isalnum() or c=='_'
                    elif cat==6:found |= not(c.isalnum() or c=='_')
                ok=found!=bool(b%2)
            if ok:pos+=1
        elif op==5:stack.append((b,pos,caps.copy()));pc=a
        elif op==6:pc=a
        elif op==7:caps[a]=pos
        elif op==8:ok=(pos>=b and match_at(a,text,pos-b) is not None)!=bool(case)
        elif op==9:
            left=pos>0 and (text[pos-1].isalnum() or text[pos-1]=='_')
            right=pos<len(text) and (text[pos].isalnum() or text[pos]=='_')
            ok=[pos==0,pos==len(text) or (pos+1==len(text) and text[pos]=='\n'),left!=right,left==right][a]
        else:raise AssertionError(op)
        if not ok:
            if not stack:return None
            pc,pos,caps=stack.pop()

def matches(entry,text):
    out=[];pos=0
    while pos<len(text):
        caps=match_at(entry,text,pos)
        if caps is None:pos+=1
        else:
            out.append(caps);pos=caps[1]
    return out

def corpus(module,tree):
    demo=next(n for n in tree.body if isinstance(n,ast.If) and '__main__' in ast.unparse(n.test))
    cases=next(n for n in demo.body if isinstance(n,ast.Assign) and any(isinstance(x,ast.Name) and x.id=='cases' for x in n.targets))
    texts=[s for _,s in ast.literal_eval(cases.value)]
    texts += ['', ' \t\n', 'Hello', 'Dr. Smith met Prof. Jones. Next!',
              'a.m. Before lunch. p.m. After lunch.', "can't won't shan't ain't let's don't they're I've we'll I'd I'm it's",
              "I can’t, won’t, and shouldn’t change curly quotes.", 'Café Cafe\u0301 İ ΟΣ ΟΣΑ ẞ ᾈ 각 𝟝',
              'A\u0315\u0300 Ạ\u030a', '© ² ⑫ Ⅳ １２ ١٢ १.५०',
              '(Hello)—[world]… «yes» “no” {ok}!', 'Visit http://x.test or WWW.X.test.',
              'http://x.test', '<b>HELLO</b> a.b+test@EXAMPLE.COM.',
              '$1.00 €0.01 £2.50 ¥1 ₹2 ₩3 ₿4 $2.5M',
              '3.10% 3.10km 3.10 0.00001% 1e-4 1E+4',
              '9007199254740993 99999999999999999999999999999',
              '999:99 25:99:59 PM 1/0 0/2 2000s 00s 100th 101st',
              '555-1234 1-800-555-0199 12-123-456-7890 1-555-1234',
              '１２３.１２３.１.１', '5Μs 5µs 5μs 10°C 10C°',
              'a'*399, 'a'*400, 'a'*401, 'hello '*150,
              'ab.'*150, '😀'*401, ' sentence. '*100]
    rng=random.Random(803)
    amounts=['0','1','12','1200','1.50','-0.5','1,200.50','5e-4','0.00000000001','1/4','7B','3rd']
    units=['%','km',' GB','°C','pm',' dollars',' cats','']
    for _ in range(250):texts.append('Dr. '+rng.choice(["can't",'PAID','costs','owns'])+' '+rng.choice(amounts)+rng.choice(units)+rng.choice(['.','!','?',',','']))
    for _ in range(1000):
        digits="".join(rng.choices("0123456789",k=rng.randrange(1,20)))
        fraction="".join(rng.choices("0123456789",k=rng.randrange(1,24)))
        texts.append(rng.choice(["", "-", "$", "£"])+digits+"."+fraction+rng.choice(["", "%", "km", "M"]))
    texts += ["0."+"0"*n+"1"+suffix for n in [3,4,5,15,16,307,323,324] for suffix in ["", "%", "km"]]
    texts += ["9"*n+suffix for n in [308,309] for suffix in ["", "%", " dollars"]]
    texts += ['0.00001%', 'The rate is 0.00001%.', '0.000010%', '-0.00001%',
              '0.00001 kg', '0.0000125%', '10000000000000000.0%',
              '0.0001%', '0.00001', '0.0%', '1.50%', '12.50 kg']
    fixtures=[]
    pp=module.TextPreprocessor(remove_punctuation=False)
    for text in texts:
        try:
            normalized=pp(text)
            fixtures.append({'input':text,'normalized':normalized,'chunks':module.chunk_text(normalized)})
        except (ValueError,OverflowError,KeyError) as ex:
            fixtures.append({'input':text,'error':type(ex).__name__})
    original=module.float_to_words
    def corrected(value):
        representation=str(value)
        if isinstance(value,float) and 'e' in representation:
            mantissa,exponent=representation.split('e'); exponent=int(exponent)
            if exponent<0: return original(format(Decimal(representation),'f'))
            return original(mantissa)+' times ten to the '+module.number_to_words(exponent)
        return original(value)
    module.float_to_words=corrected
    try:
        for fixture in fixtures:
            try:
                normalized=pp(fixture['input'])
                if normalized!=fixture.get('normalized'):
                    fixture['wfloat']={'normalized':normalized,'chunks':module.chunk_text(normalized),
                        'reason':'Fix valid scientific float representations in percentages/units'}
            except (ValueError,OverflowError,KeyError): pass
    finally: module.float_to_words=original
    return fixtures

class SourceTests(unittest.TestCase):
    def test_generated_regex_matches_python(self):
        patterns=g.patterns(MODULE,TREE)
        texts=[f['input'] for f in FIXTURES if len(f['input'])<=500]
        rng=random.Random(16)
        texts += [''.join(rng.choices("aBıİſK012. -,!\n'_µμΜéα\t١²",k=50)) for _ in range(40)]
        count=0
        for name,(pattern,flags) in patterns.items():
            native = None
            if PROBE:
                payload = ("\n".join(" ".join(f"{ord(c):x}" for c in t) for t in texts)+"\n").encode()
                native = subprocess.check_output([PROBE,f"rx:{ENTRIES[name]}"],input=payload,stderr=subprocess.PIPE).decode().splitlines()
                self.assertEqual(len(native),len(texts))
            for i,text in enumerate(texts):
                expected=[]
                for match in re.finditer(pattern,text,flags):
                    caps=[None]*16
                    for group in range(len(match.groups())+1):
                        a,b=match.span(group)
                        if a>=0:caps[group*2:group*2+2]=[a,b]
                    expected.append(caps)
                self.assertEqual(matches(ENTRIES[name],text),expected,(name,text))
                if native is not None:
                    actual = [[None if v=="-" else int(v) for v in m.split(",")[:-1]] for m in native[i].split("|")[:-1]]
                    self.assertEqual(actual,expected,(name,text,"C++"))
                count+=1
        print(f'Checked {count} generated-pattern/reference comparisons')

    def test_cpp_float_repr(self):
        if not PROBE: self.skipTest("Supply --probe for actual C++ execution")
        rng=random.Random(803)
        values=[0.0,-0.0,1.0,-1.0,1e-4,1e16,math.ulp(0.0),sys.float_info.max]
        for _ in range(100000):
            value=struct.unpack('d',struct.pack('Q',rng.getrandbits(64)))[0]
            if math.isfinite(value): values.append(value)
        texts=[str(v) for v in values]
        payload=("\n".join(" ".join(f"{ord(c):x}" for c in t) for t in texts)+"\n").encode()
        lines=subprocess.check_output([PROBE,"float"],input=payload,stderr=subprocess.PIPE,timeout=120).decode().splitlines()
        self.assertEqual(len(lines),len(texts))
        for text,line in zip(texts,lines):
            self.assertNotEqual(line,"ERROR",text)
            actual="".join(chr(int(x,16)) for x in line.split())
            self.assertEqual(actual,text,text)
        print(f"Executed C++ shortest float repr on {len(texts)} finite doubles")

    def test_cpp_work_bound(self):
        if not PROBE: self.skipTest("Supply --probe for actual C++ execution")
        text="0."+"0"*1000+"1"
        payload=(" ".join(f"{ord(c):x}" for c in text)+"\n").encode()
        result=subprocess.run([PROBE,"norm"],input=payload,capture_output=True,timeout=10,check=True)
        self.assertEqual(result.stdout,b"ERROR\n")
        self.assertIn(b"pattern work limit exceeded",result.stderr)

    def test_cpp_unicode_algorithms(self):
        if not PROBE: self.skipTest("Supply --probe for actual C++ execution")
        texts=[chr(cp) for cp in range(0x110000) if not 0xd800<=cp<=0xdfff]
        rng=random.Random(16)
        marks=[chr(cp) for cp in range(0x110000) if ud.combining(chr(cp))]
        texts += [rng.choice(["A","Ο","İ","가", "Ḋ"])+"".join(rng.choices(marks,k=6))+"Σ" for _ in range(2000)]
        payload=("\n".join(" ".join(f"{ord(c):x}" for c in t) for t in texts)+"\n").encode()
        for mode in ["nfc","lower"]:
            lines=subprocess.check_output([PROBE,mode],input=payload,stderr=subprocess.PIPE).decode().splitlines()
            self.assertEqual(len(lines),len(texts))
            for text,line in zip(texts,lines):
                actual="".join(chr(int(x,16)) for x in line.split())
                self.assertEqual(actual,ud.normalize("NFC",text) if mode=="nfc" else text.lower(),repr(text))
        print(f"Executed C++ NFC/lower on {len(texts)} inputs each")

    def test_unicode_tables(self):
        path=OUT/'offline-tts-kitten-text-data.h'
        flat=array('kDecompose',path); decomp={flat[i]:flat[i+1:i+3] for i in range(0,len(flat),3)}
        flat=array('kCompose',path); compose={(flat[i],flat[i+1]):flat[i+2] for i in range(0,len(flat),3)}
        flat=array('kCombining',path); combining=dict(zip(flat[::2],flat[1::2]))
        flat=array('kLower',path); lower={flat[i]:''.join(chr(c) for c in flat[i+1:i+3] if c) for i in range(0,len(flat),3)}
        for cp in range(0x110000):
            c=chr(cp)
            self.assertEqual(lower.get(cp,c),c.lower())
            self.assertEqual(combining.get(cp,0),ud.combining(c))
            d=ud.decomposition(c)
            if d and not d.startswith('<') and not 0xac00<=cp<=0xd7a3:
                self.assertEqual([x for x in decomp[cp] if x],[int(x,16) for x in d.split()])
        for (a,b),cp in compose.items():self.assertEqual(ud.normalize('NFC',chr(a)+chr(b)),chr(cp))

    def test_cpp_against_pinned_normalization_and_chunks(self):
        if not PROBE: self.skipTest("Native build deferred: supply --probe after parent builds it")
        payload=('\n'.join(' '.join(f'{ord(c):x}' for c in f['input']) for f in FIXTURES)+'\n').encode()
        def decode(s):return ''.join(chr(int(x,16)) for x in s.split())
        for mode,key in [('norm','normalized'),('chunks','chunks')]:
            lines=subprocess.check_output([PROBE,mode],input=payload,stderr=subprocess.PIPE).decode().splitlines()
            self.assertEqual(len(lines),len(FIXTURES))
            for line,fixture in zip(lines,FIXTURES):
                f=fixture.get('wfloat',fixture)|{'input':fixture['input']}
                if 'error' in f:self.assertEqual(line,'ERROR',f);continue
                self.assertNotEqual(line,'ERROR',f['input'])
                actual=decode(line) if mode=='norm' else [decode(s) for s in line.split('|')[:-1]]
                self.assertEqual(actual,f[key],f['input'])

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('source');ap.add_argument('--probe');ap.add_argument('--write-fixtures',action='store_true')
    args=ap.parse_args();assert ud.unidata_version=='16.0.0'
    MODULE,TREE=g.load_source(args.source);FIXTURES=corpus(MODULE,TREE);PROBE=args.probe
    if args.write_fixtures:
        (HERE/'normalization-fixtures.json').write_text(json.dumps({'sourceSha256':g.SOURCE_HASH,'unicodeVersion':ud.unidata_version,'fixtures':FIXTURES},ensure_ascii=False,indent=2)+'\n')
    unittest.main(argv=[sys.argv[0]],failfast=True)
