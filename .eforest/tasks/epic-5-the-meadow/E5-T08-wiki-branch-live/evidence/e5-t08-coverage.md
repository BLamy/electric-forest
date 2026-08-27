# E5-T08 exact-head per-hunk runtime classification

baseline=de9f59940eac1b6624a824965165d1cab5bd5b78
candidate-head=ecb4cf983d468403b65a6d3a677096e63cad9de8
classified-hunks=116

| file | old hunk | new hunk | class | runtime evidence or waiver |
| --- | ---: | ---: | --- | --- |
| .eforest/tasks/epic-5-the-meadow/E5-T08-wiki-branch-live/evidence/e5-t08-golden.digest | 1,1 | 1,1 | frozen-golden | browser and independent replay compare against this pre-run digest |
| .eforest/tasks/epic-5-the-meadow/E5-T08-wiki-branch-live/readme.md | 361,0 | 362,17 | documentation | verification-log text has no runtime branch |
| Makefile | 689,2 | 688,0 | gate-wiring | focused make target executes only E5-T08 builds and checks |
| Makefile | 692,2 | 690,7 | gate-wiring | focused make target executes only E5-T08 builds and checks |
| Makefile | 694,0 | 698,2 | gate-wiring | focused make target executes only E5-T08 builds and checks |
| apps/web/src/wiki/WikiEditor.tsx | 4,1 | 4,1 | runtime | two-session browser run executes patch, stale refusal, and full-write dispatch |
| apps/web/src/wiki/WikiEditor.tsx | 62,0 | 63,8 | runtime | two-session browser run executes patch, stale refusal, and full-write dispatch |
| apps/web/src/wiki/WikiEditor.tsx | 64,1 | 72,2 | runtime | two-session browser run executes patch, stale refusal, and full-write dispatch |
| apps/web/src/wiki/WikiEditor.tsx | 137,1 | 146,1 | runtime | two-session browser run executes patch, stale refusal, and full-write dispatch |
| apps/web/src/wiki/renderMarkdown.test.ts | 35,1 | 35,3 | deterministic-test | focused hostile corpus names the sanitizer assertion used by sabotage |
| apps/web/src/wiki/useWiki.test.ts | 3,0 | 4,1 | deterministic-test | focused Vitest freezes chooser, base, and exact content generation |
| apps/web/src/wiki/useWiki.test.ts | 11,0 | 13,1 | deterministic-test | focused Vitest freezes chooser, base, and exact content generation |
| apps/web/src/wiki/useWiki.test.ts | 40,1 | 42,1 | deterministic-test | focused Vitest freezes chooser, base, and exact content generation |
| apps/web/src/wiki/useWiki.test.ts | 43,2 | 45,1 | deterministic-test | focused Vitest freezes chooser, base, and exact content generation |
| apps/web/src/wiki/useWiki.test.ts | 45,0 | 47,14 | deterministic-test | focused Vitest freezes chooser, base, and exact content generation |
| apps/web/src/wiki/useWiki.test.ts | 47,13 | 62,39 | deterministic-test | focused Vitest freezes chooser, base, and exact content generation |
| apps/web/src/wiki/useWiki.ts | 14,0 | 15,1 | runtime | browser edits at offsets 3, 4, and 5 exercise patch and full-write branches |
| apps/web/src/wiki/useWiki.ts | 18,0 | 20,1 | runtime | browser edits at offsets 3, 4, and 5 exercise patch and full-write branches |
| apps/web/src/wiki/useWiki.ts | 175,0 | 178,26 | runtime | browser edits at offsets 3, 4, and 5 exercise patch and full-write branches |
| apps/web/test/wiki-fixture.ts | 8,0 | 9,1 | fixture | literal expected 11-event log compared byte-for-byte by browser oracle |
| apps/web/test/wiki-fixture.ts | 34,1 | 35,1 | fixture | literal expected 11-event log compared byte-for-byte by browser oracle |
| apps/web/test/wiki-fixture.ts | 35,0 | 37,7 | fixture | literal expected 11-event log compared byte-for-byte by browser oracle |
| apps/web/test/wiki-fixture.ts | 69,1 | 77,1 | fixture | literal expected 11-event log compared byte-for-byte by browser oracle |
| apps/web/test/wiki-fixture.ts | 75,3 | 82,0 | fixture | literal expected 11-event log compared byte-for-byte by browser oracle |
| apps/web/test/wiki-fixture.ts | 79,1 | 84,24 | fixture | literal expected 11-event log compared byte-for-byte by browser oracle |
| apps/web/test/wiki.pw.ts | 1,0 | 2,1 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 42,0 | 44,3 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 44,1 | 47,0 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 55,0 | 59,4 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 64,0 | 72,1 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 469,1 | 477,1 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 471,1 | 479,1 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 474,1 | 482,1 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 524,1 | 532,1 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 546,0 | 555,7 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 549,0 | 565,1 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 551,1 | 567,4 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 553,0 | 573,44 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 555,0 | 619,43 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 558,0 | 665,1 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 584,1 | 691,1 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 595,1 | 702,1 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 621,0 | 729,24 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 637,1 | 768,1 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 652,0 | 784,3 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 709,2 | 842,0 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 712,10 | 844,3 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 727,1 | 852,6 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 735,1 | 865,1 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 751,0 | 882,5 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 754,1 | 889,1 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 763,0 | 899,3 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 790,0 | 929,3 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 801,1 | 942,15 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 853,1 | 1008,1 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 856,1 | 1011,4 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 871,1 | 1029,2 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 876,14 | 1034,0 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 894,0 | 1040,1 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 903,0 | 1050,2 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 906,4 | 1054,1 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 913,0 | 1059,3 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 915,0 | 1064,4 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 920,1 | 1072,5 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 922,0 | 1079,11 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 924,0 | 1092,16 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 927,0 | 1111,4 | verification-harness | the focused Playwright fallback executes this exact file |
| apps/web/test/wiki.pw.ts | 945,1 | 1132,1 | verification-harness | the focused Playwright fallback executes this exact file |
| packages/platform/src/gateway.ts | 13,0 | 14,1 | runtime | full-write request at metadata offset 5 stages canonical content before append |
| packages/platform/src/gateway.ts | 46,0 | 48,1 | runtime | full-write request at metadata offset 5 stages canonical content before append |
| packages/platform/src/gateway.ts | 102,0 | 105,1 | runtime | full-write request at metadata offset 5 stages canonical content before append |
| packages/platform/src/gateway.ts | 267,0 | 271,96 | runtime | full-write request at metadata offset 5 stages canonical content before append |
| packages/platform/src/gateway.ts | 833,0 | 933,1 | runtime | full-write request at metadata offset 5 stages canonical content before append |
| packages/platform/src/gateway.ts | 850,0 | 951,12 | runtime | full-write request at metadata offset 5 stages canonical content before append |
| packages/platform/src/gateway.ts | 861,0 | 974,1 | runtime | full-write request at metadata offset 5 stages canonical content before append |
| packages/platform/src/gateway.ts | 1296,0 | 1410,12 | runtime | full-write request at metadata offset 5 stages canonical content before append |
| packages/platform/src/gateway.ts | 1465,0 | 1591,45 | runtime | full-write request at metadata offset 5 stages canonical content before append |
| packages/platform/src/gateway.ts | 1473,30 | 1643,1 | runtime | full-write request at metadata offset 5 stages canonical content before append |
| packages/platform/src/gateway.ts | 1516,30 | 1657,1 | runtime | full-write request at metadata offset 5 stages canonical content before append |
| packages/platform/src/gateway.ts | 1554,0 | 1667,1 | runtime | full-write request at metadata offset 5 stages canonical content before append |
| packages/platform/src/gateway.ts | 2425,0 | 2539,1 | runtime | full-write request at metadata offset 5 stages canonical content before append |
| packages/platform/src/gateway.ts | 2460,0 | 2575,3 | runtime | full-write request at metadata offset 5 stages canonical content before append |
| packages/platform/src/gateway.ts | 2488,0 | 2606,1 | runtime | full-write request at metadata offset 5 stages canonical content before append |
| packages/platform/src/gateway.ts | 2516,0 | 2635,15 | runtime | full-write request at metadata offset 5 stages canonical content before append |
| packages/platform/src/gateway.ts | 2524,0 | 2658,20 | runtime | full-write request at metadata offset 5 stages canonical content before append |
| packages/platform/src/gateway.ts | 2528,0 | 2682,1 | runtime | full-write request at metadata offset 5 stages canonical content before append |
| packages/reducers/src/file-content.test.ts | 268,0 | 269,34 | deterministic-test | focused Vitest freezes destination-route rename materialization |
| packages/reducers/src/file-content.ts | 333,0 | 334,1 | runtime | renamed guide view consumes projected exact bytes in both browser sessions |
| packages/web-hooks/src/index.ts | 22,0 | 23,1 | type-export | build-time API surface; no runtime branch |
| packages/web-hooks/src/useDispatch.test.ts | 40,0 | 41,40 | deterministic-test | focused Vitest asserts one request body and one fetch |
| packages/web-hooks/src/useDispatch.ts | 47,0 | 48,5 | runtime | network audit observes one POST carrying metadata plus contentEvent |
| packages/web-hooks/src/useDispatch.ts | 49,1 | 54,1 | runtime | network audit observes one POST carrying metadata plus contentEvent |
| packages/web-hooks/src/useDispatch.ts | 143,1 | 148,1 | runtime | network audit observes one POST carrying metadata plus contentEvent |
| packages/web-hooks/src/useDispatch.ts | 154,1 | 159,5 | runtime | network audit observes one POST carrying metadata plus contentEvent |
| packages/web-hooks/src/useDispatch.ts | 183,1 | 192,1 | runtime | network audit observes one POST carrying metadata plus contentEvent |
| packages/web-hooks/src/useDispatch.ts | 187,1 | 196,1 | runtime | network audit observes one POST carrying metadata plus contentEvent |
| packages/web-hooks/src/useDispatch.ts | 202,4 | 211,7 | runtime | network audit observes one POST carrying metadata plus contentEvent |
| tools/verify/e5_t08_coverage.mjs | 0,0 | 1,143 | verification-harness | self-enumerates exact candidate diff and rejects unknown hunks |
| tools/verify/e5_t08_evidence.mjs | 12,1 | 12,4 | deterministic-verifier | focused gate independently replays and checks committed artifacts |
| tools/verify/e5_t08_evidence.mjs | 15,1 | 18,1 | deterministic-verifier | focused gate independently replays and checks committed artifacts |
| tools/verify/e5_t08_evidence.mjs | 18,0 | 22,1 | deterministic-verifier | focused gate independently replays and checks committed artifacts |
| tools/verify/e5_t08_evidence.mjs | 42,0 | 47,3 | deterministic-verifier | focused gate independently replays and checks committed artifacts |
| tools/verify/e5_t08_evidence.mjs | 55,1 | 62,10 | deterministic-verifier | focused gate independently replays and checks committed artifacts |
| tools/verify/e5_t08_evidence.mjs | 73,1 | 89,1 | deterministic-verifier | focused gate independently replays and checks committed artifacts |
| tools/verify/e5_t08_evidence.mjs | 76,1 | 92,3 | deterministic-verifier | focused gate independently replays and checks committed artifacts |
| tools/verify/e5_t08_evidence.mjs | 88,1 | 106,2 | deterministic-verifier | focused gate independently replays and checks committed artifacts |
| tools/verify/e5_t08_evidence.mjs | 91,0 | 111,2 | deterministic-verifier | focused gate independently replays and checks committed artifacts |
| tools/verify/e5_t08_evidence.mjs | 93,0 | 115,2 | deterministic-verifier | focused gate independently replays and checks committed artifacts |
| tools/verify/e5_t08_evidence.mjs | 95,7 | 118,7 | deterministic-verifier | focused gate independently replays and checks committed artifacts |
| tools/verify/e5_t08_evidence.mjs | 103,1 | 126,9 | deterministic-verifier | focused gate independently replays and checks committed artifacts |
| tools/verify/e5_t08_evidence.mjs | 110,0 | 142,3 | deterministic-verifier | focused gate independently replays and checks committed artifacts |
| tools/verify/e5_t08_evidence.mjs | 113,0 | 148,16 | deterministic-verifier | focused gate independently replays and checks committed artifacts |
| tools/verify/e5_t08_evidence.mjs | 117,4 | 167,5 | deterministic-verifier | focused gate independently replays and checks committed artifacts |
| tools/verify/e5_t08_evidence.mjs | 124,1 | 175,4 | deterministic-verifier | focused gate independently replays and checks committed artifacts |
| tools/verify/e5_t08_evidence.mjs | 128,1 | 182,1 | deterministic-verifier | focused gate independently replays and checks committed artifacts |
| tools/verify/e5_t08_sensitivity.mjs | 0,0 | 1,277 | verification-harness | focused gate executes five causal mutation runs |

behavior=canonical-full-write event=fs.file.write metadata-offset=0000000000000000_0000000000000005 source=WikiEditor+useDispatch+gateway class=runtime exact-bytes=both-sessions+content-stream+blob-replay
behavior=pointer-rename event=fs.rename metadata-offset=0000000000000000_0000000000000006 source=WikiPage.tsx baseline-hunk class=runtime old-route=missing new-route=writer-follower-converged

E5_T08_COVERAGE_OK
