#!/usr/bin/env python3
"""Run the production playback focus guard with cached Kotlin tools; no downloads."""
from pathlib import Path
import os
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
cache = Path.home() / '.gradle/caches/modules-2/files-2.1'
def jar(group, artifact, version='*'):
    matches = sorted((cache / group / artifact).glob(f'{version}/*/*.jar'))
    if not matches:
        raise SystemExit(f'Missing cached {group}:{artifact}; run the normal Android Kotlin build first.')
    return str(matches[-1])
stdlib = jar('org.jetbrains.kotlin', 'kotlin-stdlib', '1.9.24')
annotations = jar('org.jetbrains', 'annotations')
compiler = ':'.join([jar('org.jetbrains.kotlin', 'kotlin-compiler-embeddable', '1.9.24'), stdlib,
                     jar('org.jetbrains.kotlin', 'kotlin-reflect'), jar('org.jetbrains.kotlin', 'kotlin-script-runtime'),
                     jar('org.jetbrains.intellij.deps', 'trove4j'), annotations])
java = str(Path(os.environ.get('JAVA_HOME', '/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home')) / 'bin/java')
with tempfile.TemporaryDirectory(prefix='wfloat-focus-classes-') as output:
    subprocess.run([java, '-cp', compiler, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
                    '-no-stdlib', '-no-reflect', '-classpath', ':'.join([stdlib, annotations]),
                    '-d', output, str(root / 'src/main/java/com/wfloat/NextPlaybackFocus.kt'),
                    str(root / 'tests/focus/FocusTest.kt')], check=True)
    subprocess.run([java, '-cp', ':'.join([output, stdlib]), 'com.wfloat.FocusTestKt'], check=True)
