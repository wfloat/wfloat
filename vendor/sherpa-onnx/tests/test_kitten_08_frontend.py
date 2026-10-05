#!/usr/bin/env python3
"""No ORT/eSpeak/model execution: compile pure frontend helpers and compare to
Python Unicode/re semantics. Run from any directory with python3 this_file.
"""
import pathlib
import random
import re
import subprocess
import tempfile
import unittest
import unicodedata

ROOT = pathlib.Path(__file__).resolve().parents[1]
PROBE = r'''
#include <cassert>
#include <iostream>
#include <sstream>
#include "sherpa-onnx/csrc/offline-tts-kitten-utils.h"
using namespace sherpa_onnx;
int main(int argc, char **argv) {
  if (argc == 2 && std::string(argv[1]) == "unicode") {
    for (char32_t c = 0; c <= 0x10ffff; ++c)
      std::cout.put(KittenIsWord(c) + 2 * KittenIsSpace(c));
    return 0;
  }
  OfflineTtsKittenModelMetaData meta;
  assert(!IsKitten08(meta));
  for (int v : {1, 2, 7, 9, 80}) {meta.version=v; assert(!IsKitten08(meta));}
  meta.version=8; assert(IsKitten08(meta));
  assert(Kitten08StyleRow(0, 400)==0);
  assert(Kitten08StyleRow(1, 400)==1);
  assert(Kitten08StyleRow(399, 400)==399);
  assert(Kitten08StyleRow(400, 400)==399);
  assert(Kitten08StyleRow(INT64_MAX, 400)==399);
  assert(Kitten08StyleRow(400, 1)==0);
  bool threw=false;
  try {Kitten08StyleRow(-1,400);} catch(const std::invalid_argument &) {threw=true;}
  assert(threw);
  for(int64_t n : {0, 1, 4999, 5000, 5001, 10000}) {
    assert(KittenAudioLength(n,8)==std::max<int64_t>(0,n-5000));
    assert(KittenAudioLength(n,1)==n);
    assert(KittenAudioLength(n,9)==n);
  }
  // Each inference is trimmed independently: 6000 + 7000 -> 1000 + 2000.
  assert(KittenAudioLength(6000,8)+KittenAudioLength(7000,8)==3000);
  std::unordered_map<char32_t,int32_t> table;
  // A deliberately sparse vocabulary tests filtering AFTER tokenization.
  for(char32_t c : U" abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.!,;:?'—ɑɐæðəɚɛɡɪŋɔɹʃʊʌʒʔˈˌːˑʼʴʰʱʲʷˠˤ˞↓↑→↗↘̩ᵻ")
    if(c) table[c]=static_cast<int32_t>(c);
  meta.end_id=10; meta.add_pad_after_end=1; meta.max_token_len=400;
  std::string line;
  while(std::getline(std::cin,line)) {
    std::istringstream stream(line); std::vector<char32_t> chars; uint32_t c;
    while(stream>>std::hex>>c) chars.push_back(c);
    try {
      auto ids=Kitten08TokenIds(chars,table,meta);
      for(auto id:ids) std::cout<<id<<' ';
      std::cout<<'\n';
    } catch(const std::length_error &) {std::cout<<"overflow\n";}
  }
}
'''
VOCAB = " abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.!,;:?'—ɑɐæðəɚɛɡɪŋɔɹʃʊʌʒʔˈˌːˑʼʴʰʱʲʷˠˤ˞↓↑→↗↘̩ᵻ"

class KittenFrontendTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='kitten-frontend-')
        source = pathlib.Path(cls.tmp.name) / 'probe.cc'
        source.write_text(PROBE)
        cls.binary = str(source.with_suffix(''))
        subprocess.run(['clang++', '-std=c++17', '-Wall', '-Wextra', '-Werror',
                        '-I', str(ROOT), str(source), '-o', cls.binary], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    @unittest.skipUnless(unicodedata.unidata_version == "16.0.0",
                         "Exhaustive comparison requires pinned Unicode 16.0.0")
    def test_unicode_word_and_space_match_python(self):
        actual = subprocess.check_output([self.binary, 'unicode'])
        expected = bytes((c.isalnum() or c == '_') + 2 * c.isspace()
                         for c in map(chr, range(0x110000)))
        self.assertEqual(actual, expected)

    def test_spacing_filtering_bounds_and_policy(self):
        cases = ['', '  \n\t', 'həlˈoʊ, wˈɜːld!', 'a...b', 'a̩b',
                 "a'b", 'a\u2003b', 'hello. world!', 'a🎉b', 'aЖb',
                 'a©b', 'a' * 397, 'a' * 398, 'a' * 400, 'a' * 1000]
        rng = random.Random(8)
        alphabet = VOCAB + '\t\n\u00a0\u3000🎉Ж©\u0301'
        cases += [''.join(rng.choices(alphabet, k=rng.randrange(1, 280)))
                  for _ in range(500)]
        payload = '\n'.join(' '.join(f'{ord(c):x}' for c in s) for s in cases)+'\n'
        actual = subprocess.check_output([self.binary], input=payload.encode()).decode().splitlines()
        for text, line in zip(cases, actual):
            groups = re.findall(r'\w+|[^\w\s]', text)
            ids = [0] + [ord(c) for c in ' '.join(groups) if c in VOCAB] + [10, 0] if groups else []
            expected = 'overflow' if len(ids) > 400 else ' '.join(map(str, ids))
            self.assertEqual(line.strip(), expected, repr(text))
        self.assertEqual(len(actual), len(cases))

if __name__ == '__main__':
    unittest.main()
