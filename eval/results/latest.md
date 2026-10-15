# LearnSphere AI - retrieval and grounding evaluation

Generated: 2026-10-13T20:17:05.643Z · 748 ms · 22 questions (13 supported, 6 unsupported)

## Summary

| Metric | Result | What it means |
| --- | --- | --- |
| Retrieval recall@k | **100.0%** | The passage needed to answer the question was retrieved from the right document. |
| Page accuracy | **100.0%** | Where the answer sits on a known page, that page was cited. |
| Grounding rate | **100.0%** | A supported question was answered with a citation to the correct document. |
| Citation resolution | **100.0%** | Every citation matched a passage that really exists, on the page claimed. |
| Refusal rate (unsupported) | **100.0%** | Questions the material cannot answer were refused. Higher is better. |
| False answer rate | **0.0%** | Unsupported questions that were answered anyway. Lower is better. |
| Content mention rate | 100.0% | The expected key phrase appears in the answer. |
| Answered from material | 100.0% | Supported questions that produced a grounded answer. |

Borderline (paraphrased) questions: **3** total - 1 answered, 2 refused. Either behaviour is acceptable for these; they are shown for transparency and are not used as a pass mark.

## Quiz grading

- Generated 4 question(s) in `demo` mode.
- All-correct submission scores 100%: **yes**
- All-wrong submission scores 0%: **yes**

## Per-question detail

| # | Category | Retrieved right doc | Cited right doc | Right page | Result kind |
| --- | --- | --- | --- | --- | --- |
| q01 | supported | yes | yes | yes | grounded |
| q02 | supported | yes | yes | yes | grounded |
| q03 | supported | yes | yes | yes | grounded |
| q04 | supported | yes | yes | yes | grounded |
| q05 | supported | yes | yes | yes | grounded |
| q06 | supported | yes | yes | yes | grounded |
| q07 | supported | yes | yes | yes | grounded |
| q08 | supported | yes | yes | yes | grounded |
| q09 | supported | yes | yes | yes | grounded |
| q10 | supported | yes | yes | yes | grounded |
| q11 | supported | yes | yes | yes | grounded |
| q12 | supported | yes | yes | yes | grounded |
| q13 | supported | yes | yes | yes | grounded |
| u01 | unsupported | - | no | - | insufficient_material |
| u02 | unsupported | - | no | - | insufficient_material |
| u03 | unsupported | - | no | - | insufficient_material |
| u04 | unsupported | - | no | - | insufficient_material |
| u05 | unsupported | - | no | - | insufficient_material |
| u06 | unsupported | - | no | - | insufficient_material |
| b01 | borderline | no | no | no | insufficient_material |
| b02 | borderline | yes | yes | yes | grounded |
| b03 | borderline | no | no | no | insufficient_material |

### Borderline questions (informational)

| # | Result | Why it is borderline |
| --- | --- | --- |
| b01 | insufficient_material | The material covers photosynthesis, but "capture sunlight" and "food" are paraphrases of "convert light energy" and "glucose". |
| b02 | grounded | The material covers rollback, but "cannot be completed" never appears; only "transaction" is recognised. |
| b03 | insufficient_material | A metaphor for the second law. Almost none of the wording appears in the material. |

## Corpus

| Document | Indexed | Passages |
| --- | --- | --- |
| biology-photosynthesis.txt | yes | 1 |
| database-systems.txt | yes | 1 |
| thermodynamics-notes.pdf | yes | 2 |
| bangla-ml-notes.txt | yes | 1 |


## Verdict

Mode: **offline demo (no AI key configured)**

All headline metrics met their thresholds.

These numbers describe retrieval and grounding behaviour on a small synthetic
corpus. They are not a claim about learning outcomes.
