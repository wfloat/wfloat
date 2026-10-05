#pragma once
#include <string>
#include <vector>
// Ported from stt-next/sherpa.ts; learned scores are unchanged.
/*!
 * Bundled Zipformer vocabulary: simple-sentencepiece test fixture.
 * Copyright 2024 Wei Kang. SPDX-License-Identifier: Apache-2.0
 * Copied without changing vocabulary contents; encoded as a JS string above.
 * Source commit: 62dd423df1d51da5ea06f1c3a046fc04f01b4f39
 * The following license applies to that vocabulary, not the whole Wfloat SDK.

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.

*/

namespace wfloat_next {
inline constexpr const char* zipformerVocabulary = R"WFLOAT(<blk>	0
<sos/eos>	0
<unk>	0
S	-3.23764
▁THE	-3.39114
▁A	-3.91235
T	-3.9788
▁AND	-4.04148
ED	-4.06805
▁OF	-4.11122
▁TO	-4.14819
E	-4.15925
D	-4.19884
N	-4.28917
ING	-4.40123
▁IN	-4.45251
Y	-4.52708
M	-4.57919
C	-4.62646
▁I	-4.68235
A	-4.68468
P	-4.69613
▁HE	-4.71198
R	-4.82144
O	-4.83893
L	-4.88007
RE	-4.88603
I	-4.90352
U	-4.91157
ER	-4.95434
▁IT	-4.99701
LY	-5.00155
▁THAT	-5.00795
▁WAS	-5.04607
▁	-5.05486
▁S	-5.05888
AR	-5.10129
▁BE	-5.14569
F	-5.18181
▁C	-5.18836
IN	-5.20029
B	-5.20859
▁FOR	-5.23485
OR	-5.26974
LE	-5.2702
'	-5.27032
▁HIS	-5.28672
▁YOU	-5.34529
AL	-5.35383
▁RE	-5.35863
V	-5.36811
▁B	-5.36912
G	-5.39337
RI	-5.41681
▁E	-5.41899
▁WITH	-5.4268
▁T	-5.49151
▁AS	-5.50186
LL	-5.50605
▁P	-5.51409
▁HER	-5.52391
ST	-5.52898
▁HAD	-5.53885
▁SO	-5.56342
▁F	-5.56472
W	-5.57126
CE	-5.61235
▁IS	-5.63341
ND	-5.63677
▁NOT	-5.64685
TH	-5.65822
▁BUT	-5.65885
EN	-5.67118
▁SHE	-5.67453
▁ON	-5.67506
VE	-5.6788
ON	-5.68108
SE	-5.68128
▁DE	-5.68499
UR	-5.70257
▁G	-5.70716
CH	-5.71597
K	-5.73117
TER	-5.73588
▁AT	-5.74333
IT	-5.75281
▁ME	-5.75999
RO	-5.78792
NE	-5.81237
RA	-5.84735
ES	-5.86915
IL	-5.9164
NG	-5.95522
IC	-5.95622
▁NO	-5.95875
▁HIM	-5.9632
ENT	-5.96542
IR	-5.98727
▁WE	-6.00283
H	-6.00505
▁DO	-6.01678
▁ALL	-6.0215
▁HAVE	-6.04155
LO	-6.04175
▁BY	-6.0754
▁MY	-6.07629
▁MO	-6.07686
▁THIS	-6.07749
LA	-6.07936
▁ST	-6.10084
▁WHICH	-6.10116
▁CON	-6.11572
▁THEY	-6.13378
CK	-6.13419
TE	-6.14807
▁SAID	-6.15974
▁FROM	-6.16115
▁GO	-6.16495
▁WHO	-6.17239
▁TH	-6.18452
▁OR	-6.18883
▁D	-6.18975
▁W	-6.19439
VER	-6.20494
LI	-6.22095
▁SE	-6.2297
▁ONE	-6.23026
▁CA	-6.23397
▁AN	-6.24262
▁LA	-6.24786
▁WERE	-6.24858
EL	-6.271
▁HA	-6.28368
▁MAN	-6.29896
▁FA	-6.31168
▁EX	-6.31364
AD	-6.31526
▁SU	-6.34091
RY	-6.35457
▁MI	-6.37021
AT	-6.39107
▁BO	-6.39815
▁WHEN	-6.40637
AN	-6.41853
THER	-6.42115
PP	-6.43792
ATION	-6.44105
▁FI	-6.45761
▁WOULD	-6.47257
▁PRO	-6.47274
OW	-6.48047
ET	-6.48289
▁O	-6.48763
▁THERE	-6.48808
▁HO	-6.48841
ION	-6.48846
▁WHAT	-6.49159
▁FE	-6.49797
▁PA	-6.50029
US	-6.50081
MENT	-6.50395
▁MA	-6.50516
UT	-6.53807
▁OUT	-6.54596
▁THEIR	-6.54897
▁IF	-6.55068
▁LI	-6.55453
▁K	-6.56374
▁WILL	-6.5669
▁ARE	-6.57477
ID	-6.57502
▁RO	-6.57553
DE	-6.58188
TION	-6.59518
▁WA	-6.59566
PE	-6.60184
▁UP	-6.60311
▁SP	-6.61112
▁PO	-6.61409
IGHT	-6.63771
▁UN	-6.64183
RU	-6.64252
▁LO	-6.64639
AS	-6.64889
OL	-6.65442
▁LE	-6.66382
▁BEEN	-6.67806
▁SH	-6.67835
▁RA	-6.68003
▁SEE	-6.69546
KE	-6.70826
UL	-6.71612
TED	-6.71696
▁SA	-6.72967
UN	-6.73177
UND	-6.73395
ANT	-6.73423
▁NE	-6.743
IS	-6.75404
▁THEM	-6.75743
CI	-6.76993
GE	-6.77069
▁COULD	-6.77503
▁DIS	-6.78135
OM	-6.79366
ISH	-6.80337
HE	-6.80705
EST	-6.81058
▁SOME	-6.81704
ENCE	-6.82267
ITY	-6.83585
IVE	-6.84022
▁US	-6.84091
▁MORE	-6.84456
▁EN	-6.84947
ARD	-6.85159
ATE	-6.86067
▁YOUR	-6.86188
▁INTO	-6.86252
▁KNOW	-6.86753
▁CO	-6.86961
ANCE	-6.8727
▁TIME	-6.8751
▁WI	-6.88392
▁YE	-6.8877
AGE	-6.8955
▁NOW	-6.90387
TI	-6.90402
FF	-6.90618
ABLE	-6.90917
▁VERY	-6.92207
▁LIKE	-6.92869
AM	-6.94687
HI	-6.94986
Z	-6.9511
▁OTHER	-6.96464
▁THAN	-6.97308
▁LITTLE	-6.97622
▁DID	-6.98152
▁LOOK	-6.98467
TY	-6.99474
ERS	-6.99918
▁CAN	-7.00994
▁CHA	-7.01063
▁AR	-7.02555
X	-7.02668
FUL	-7.03465
UGH	-7.04608
▁BA	-7.04937
▁DAY	-7.0543
▁ABOUT	-7.05554
TEN	-7.05588
IM	-7.0583
▁ANY	-7.05892
▁PRE	-7.06131
▁OVER	-7.06494
IES	-7.07832
NESS	-7.08111
ME	-7.08369
BLE	-7.08645
▁M	-7.09032
ROW	-7.09219
▁HAS	-7.0976
▁GREAT	-7.10444
▁VI	-7.10527
TA	-7.10781
▁AFTER	-7.10952
PER	-7.1132
▁AGAIN	-7.11478
HO	-7.11545
SH	-7.11555
▁UPON	-7.12675
▁DI	-7.13004
▁HAND	-7.13211
▁COM	-7.13273
IST	-7.13438
TURE	-7.13771
▁STA	-7.14628
▁THEN	-7.15775
▁SHOULD	-7.15836
▁GA	-7.16774
OUS	-7.16944
OUR	-7.16965
▁WELL	-7.17122
▁ONLY	-7.17628
MAN	-7.17899
▁GOOD	-7.18494
▁TWO	-7.18746
▁MAR	-7.18755
▁SAY	-7.19636
▁HU	-7.20214
TING	-7.20818
▁OUR	-7.21813
RESS	-7.22296
▁DOWN	-7.22319
IOUS	-7.24748
▁BEFORE	-7.24835
▁DA	-7.2508
▁NA	-7.25861
QUI	-7.26388
▁MADE	-7.26918
▁EVERY	-7.26921
▁OLD	-7.27794
▁EVEN	-7.28005
IG	-7.28081
▁COME	-7.28172
▁GRA	-7.28522
▁RI	-7.29145
▁LONG	-7.29314
OT	-7.29691
SIDE	-7.30065
WARD	-7.31155
▁FO	-7.31391
▁WHERE	-7.31479
MO	-7.31992
LESS	-7.32883
▁SC	-7.32891
▁MUST	-7.3305
▁NEVER	-7.33078
▁HOW	-7.34345
▁CAME	-7.34599
▁SUCH	-7.34721
▁RU	-7.35962
▁TAKE	-7.35962
▁WO	-7.36853
▁CAR	-7.37945
UM	-7.37964
AK	-7.39205
▁THINK	-7.40939
▁MUCH	-7.40963
▁MISTER	-7.4201
▁MAY	-7.43389
▁JO	-7.44387
▁WAY	-7.4456
▁COMP	-7.45547
▁THOUGHT	-7.45606
▁STO	-7.46284
▁MEN	-7.46377
▁BACK	-7.46526
▁DON	-7.46548
J	-7.46605
▁LET	-7.48391
▁TRA	-7.4958
▁FIRST	-7.49608
▁JUST	-7.49723
▁VA	-7.49963
▁OWN	-7.51114
▁PLA	-7.51664
▁MAKE	-7.5218
ATED	-7.52921
▁HIMSELF	-7.53339
▁WENT	-7.54
▁PI	-7.55717
GG	-7.55994
RING	-7.5606
▁DU	-7.56341
▁MIGHT	-7.56862
▁PART	-7.57009
▁GIVE	-7.58394
▁IMP	-7.58817
▁BU	-7.59192
▁PER	-7.59583
▁PLACE	-7.60502
▁HOUSE	-7.60934
▁THROUGH	-7.62521
IAN	-7.62855
▁SW	-7.63782
▁UNDER	-7.64373
QUE	-7.64402
▁AWAY	-7.64512
▁LOVE	-7.64681
QUA	-7.65031
▁LIFE	-7.66029
▁GET	-7.66648
▁WITHOUT	-7.67412
▁PASS	-7.682
▁TURN	-7.69236
IGN	-7.69649
▁HEAD	-7.69697
▁MOST	-7.70515
▁THOSE	-7.7168
▁SHALL	-7.71795
▁EYES	-7.71861
▁COL	-7.74121
▁STILL	-7.74208
▁NIGHT	-7.74542
▁NOTHING	-7.76816
ITION	-7.76824
HA	-7.76993
▁TELL	-7.76996
▁WORK	-7.77374
▁LAST	-7.77545
▁NEW	-7.78277
▁FACE	-7.78386
▁HI	-7.79126
▁WORD	-7.8012
▁FOUND	-7.80479
▁COUNT	-7.80516
▁OB	-7.80527
▁WHILE	-7.80765
▁SHA	-7.81719
▁MEAN	-7.83619
▁SAW	-7.83676
▁PEOPLE	-7.83766
▁FRIEND	-7.8565
▁THREE	-7.86814
▁ROOM	-7.87585
▁SAME	-7.88751
▁THOUGH	-7.89248
▁RIGHT	-7.89619
▁CHILD	-7.89778
▁FATHER	-7.90382
▁ANOTHER	-7.90587
▁HEART	-7.91276
▁WANT	-7.92235
▁TOOK	-7.94253
OOK	-7.94851
▁LIGHT	-7.96145
▁MISSUS	-7.9786
▁OPEN	-7.98527
▁JU	-7.9894
▁ASKED	-7.99096
PORT	-8.0012
▁LEFT	-8.00187
▁JA	-8.02979
▁WORLD	-8.03992
▁HOME	-8.04939
▁WHY	-8.0618
▁ALWAYS	-8.06564
▁ANSWER	-8.0739
▁SEEMED	-8.088
▁SOMETHING	-8.08951
▁GIRL	-8.09335
▁BECAUSE	-8.10615
▁NAME	-8.10768
▁TOLD	-8.11746
▁NI	-8.12176
▁HIGH	-8.12178
IZE	-8.13805
▁WOMAN	-8.14522
▁FOLLOW	-8.15124
▁RETURN	-8.17126
▁KNEW	-8.17579
▁EACH	-8.18032
▁KIND	-8.18787
▁JE	-8.19007
▁ACT	-8.20004
▁LU	-8.20535
▁CERTAIN	-8.21049
▁YEARS	-8.2275
▁QUITE	-8.22848
▁APPEAR	-8.23444
▁BETTER	-8.24887
▁HALF	-8.25101
▁PRESENT	-8.25108
▁PRINCE	-8.263
SHIP	-8.26654
▁ALSO	-8.27005
▁BEGAN	-8.27496
▁HAVING	-8.28474
▁ENOUGH	-8.28608
▁PERSON	-8.28836
▁LADY	-8.29498
▁WHITE	-8.3115
▁COURSE	-8.31653
▁VOICE	-8.3193
▁SPEAK	-8.32799
▁POWER	-8.35211
▁MORNING	-8.35582
▁BETWEEN	-8.3565
▁AMONG	-8.35997
▁KEEP	-8.36216
▁WALK	-8.3686
▁MATTER	-8.37061
▁TEA	-8.37863
▁BELIEVE	-8.37922
▁SMALL	-8.3814
▁TALK	-8.38939
▁FELT	-8.39477
▁HORSE	-8.39834
▁MYSELF	-8.40051
▁SIX	-8.40069
▁HOWEVER	-8.40304
▁FULL	-8.40399
▁HERSELF	-8.40714
▁POINT	-8.41248
▁STOOD	-8.41336
▁HUNDRED	-8.41404
▁ALMOST	-8.42802
▁SINCE	-8.43626
▁LARGE	-8.44207
▁LEAVE	-8.44699
▁PERHAPS	-8.4576
▁DARK	-8.46885
▁SUDDEN	-8.46906
▁REPLIED	-8.47536
▁ANYTHING	-8.48241
▁WONDER	-8.48792
▁UNTIL	-8.48926
Q	-9.78832
)WFLOAT";
inline const std::vector<std::string>& zipformerPieces() {
 static const std::vector<std::string> pieces = {
"<blk>","<sos/eos>","<unk>","S","▁THE","▁A","T","▁AND","ED","▁OF","▁TO","E","D","N","ING","▁IN","Y","M","C","▁I","A","P","▁HE","R","O","L","RE","I","U","ER","▁IT","LY","▁THAT","▁WAS","▁","▁S","AR","▁BE","F","▁C","IN","B","▁FOR","OR","LE","'","▁HIS","▁YOU","AL","▁RE","V","▁B","G","RI","▁E","▁WITH","▁T","▁AS","LL","▁P","▁HER","ST","▁HAD","▁SO","▁F","W","CE","▁IS","ND","▁NOT","TH","▁BUT","EN","▁SHE","▁ON","VE","ON","SE","▁DE","UR","▁G","CH","K","TER","▁AT","IT","▁ME","RO","NE","RA","ES","IL","NG","IC","▁NO","▁HIM","ENT","IR","▁WE","H","▁DO","▁ALL","▁HAVE","LO","▁BY","▁MY","▁MO","▁THIS","LA","▁ST","▁WHICH","▁CON","▁THEY","CK","TE","▁SAID","▁FROM","▁GO","▁WHO","▁TH","▁OR","▁D","▁W","VER","LI","▁SE","▁ONE","▁CA","▁AN","▁LA","▁WERE","EL","▁HA","▁MAN","▁FA","▁EX","AD","▁SU","RY","▁MI","AT","▁BO","▁WHEN","AN","THER","PP","ATION","▁FI","▁WOULD","▁PRO","OW","ET","▁O","▁THERE","▁HO","ION","▁WHAT","▁FE","▁PA","US","MENT","▁MA","UT","▁OUT","▁THEIR","▁IF","▁LI","▁K","▁WILL","▁ARE","ID","▁RO","DE","TION","▁WA","PE","▁UP","▁SP","▁PO","IGHT","▁UN","RU","▁LO","AS","OL","▁LE","▁BEEN","▁SH","▁RA","▁SEE","KE","UL","TED","▁SA","UN","UND","ANT","▁NE","IS","▁THEM","CI","GE","▁COULD","▁DIS","OM","ISH","HE","EST","▁SOME","ENCE","ITY","IVE","▁US","▁MORE","▁EN","ARD","ATE","▁YOUR","▁INTO","▁KNOW","▁CO","ANCE","▁TIME","▁WI","▁YE","AGE","▁NOW","TI","FF","ABLE","▁VERY","▁LIKE","AM","HI","Z","▁OTHER","▁THAN","▁LITTLE","▁DID","▁LOOK","TY","ERS","▁CAN","▁CHA","▁AR","X","FUL","UGH","▁BA","▁DAY","▁ABOUT","TEN","IM","▁ANY","▁PRE","▁OVER","IES","NESS","ME","BLE","▁M","ROW","▁HAS","▁GREAT","▁VI","TA","▁AFTER","PER","▁AGAIN","HO","SH","▁UPON","▁DI","▁HAND","▁COM","IST","TURE","▁STA","▁THEN","▁SHOULD","▁GA","OUS","OUR","▁WELL","▁ONLY","MAN","▁GOOD","▁TWO","▁MAR","▁SAY","▁HU","TING","▁OUR","RESS","▁DOWN","IOUS","▁BEFORE","▁DA","▁NA","QUI","▁MADE","▁EVERY","▁OLD","▁EVEN","IG","▁COME","▁GRA","▁RI","▁LONG","OT","SIDE","WARD","▁FO","▁WHERE","MO","LESS","▁SC","▁MUST","▁NEVER","▁HOW","▁CAME","▁SUCH","▁RU","▁TAKE","▁WO","▁CAR","UM","AK","▁THINK","▁MUCH","▁MISTER","▁MAY","▁JO","▁WAY","▁COMP","▁THOUGHT","▁STO","▁MEN","▁BACK","▁DON","J","▁LET","▁TRA","▁FIRST","▁JUST","▁VA","▁OWN","▁PLA","▁MAKE","ATED","▁HIMSELF","▁WENT","▁PI","GG","RING","▁DU","▁MIGHT","▁PART","▁GIVE","▁IMP","▁BU","▁PER","▁PLACE","▁HOUSE","▁THROUGH","IAN","▁SW","▁UNDER","QUE","▁AWAY","▁LOVE","QUA","▁LIFE","▁GET","▁WITHOUT","▁PASS","▁TURN","IGN","▁HEAD","▁MOST","▁THOSE","▁SHALL","▁EYES","▁COL","▁STILL","▁NIGHT","▁NOTHING","ITION","HA","▁TELL","▁WORK","▁LAST","▁NEW","▁FACE","▁HI","▁WORD","▁FOUND","▁COUNT","▁OB","▁WHILE","▁SHA","▁MEAN","▁SAW","▁PEOPLE","▁FRIEND","▁THREE","▁ROOM","▁SAME","▁THOUGH","▁RIGHT","▁CHILD","▁FATHER","▁ANOTHER","▁HEART","▁WANT","▁TOOK","OOK","▁LIGHT","▁MISSUS","▁OPEN","▁JU","▁ASKED","PORT","▁LEFT","▁JA","▁WORLD","▁HOME","▁WHY","▁ALWAYS","▁ANSWER","▁SEEMED","▁SOMETHING","▁GIRL","▁BECAUSE","▁NAME","▁TOLD","▁NI","▁HIGH","IZE","▁WOMAN","▁FOLLOW","▁RETURN","▁KNEW","▁EACH","▁KIND","▁JE","▁ACT","▁LU","▁CERTAIN","▁YEARS","▁QUITE","▁APPEAR","▁BETTER","▁HALF","▁PRESENT","▁PRINCE","SHIP","▁ALSO","▁BEGAN","▁HAVING","▁ENOUGH","▁PERSON","▁LADY","▁WHITE","▁COURSE","▁VOICE","▁SPEAK","▁POWER","▁MORNING","▁BETWEEN","▁AMONG","▁KEEP","▁WALK","▁MATTER","▁TEA","▁BELIEVE","▁SMALL","▁TALK","▁FELT","▁HORSE","▁MYSELF","▁SIX","▁HOWEVER","▁FULL","▁HERSELF","▁POINT","▁STOOD","▁HUNDRED","▁ALMOST","▁SINCE","▁LARGE","▁LEAVE","▁PERHAPS","▁DARK","▁SUDDEN","▁REPLIED","▁ANYTHING","▁WONDER","▁UNTIL","Q","#0","#1"};
 return pieces;
}
}
