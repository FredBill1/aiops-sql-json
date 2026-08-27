# Offline SQL function contracts

Normal builds, validation, and extension execution use the checked-in generated
files and do not fetch documentation. To update the catalogs, run
`npm run catalog:update`. The updater follows the official function indexes and
their related detail pages for the pinned versions in `function-catalog.sources.json`.
Downloaded pages are cached under the ignored `coverage/function-catalog-pages/`
directory; `npm run catalog:update -- --offline` replays that cache and fails if a
required page is missing. A replay must produce byte-for-byte identical generated
files and lock data.

`function-catalog.lock.json` records every fetched page, its content hash, the
generated contract hash, and extraction completeness. Unit fixtures exercise all
seven documentation formats without network access. `npm run catalog:verify`
checks the lock, source provenance, versions, and documented-return baselines
offline. Runtime unit tests also enforce the reviewed/generated contract floors
and fallback ceilings in `function-catalog.coverage.json`.

## Contract precedence and evidence

Dialect-specific reviewed contracts take precedence over explicitly portable
reviewed contracts, then documented contracts, then speculative fallbacks. Detail
pages enrich names from the authoritative function index; type constructors,
examples, and JSON path methods do not become callable SQL functions merely by
appearing on a detail page. Generic uses the common dialect name set.

Return-only reviewed rules and generated documentation contracts do not impose
strict argument checks. Even a completely extracted documentation signature does
not establish every implicit conversion. Incomplete overloads retain unknown
return alternatives instead of silently becoming an exhaustive overload set.
Speculative results can inform Hover, but are not evidence for type conflicts.
Known container structure and independently known errors remain checked.

## Coverage change

The following runtime counts compare the committed failure-test baseline with
this implementation. **Complete** means argument checking is enabled by the
reviewed contract; **partial** means reliable return information is available but
the complete input contract is not established; **fallback** means speculative
inference. These categories are distinct from documentation extraction
completeness. The old implementation did not represent partial contracts.

| Dialect | Complete, before → after | Partial, before → after | Fallback, before → after |
| --- | ---: | ---: | ---: |
| Spark | 64 → 70 | 0 → 102 | 405 → 297 |
| Hive | 38 → 44 | 0 → 141 | 161 → 26 |
| Flink | 29 → 30 | 0 → 55 | 187 → 131 |
| MySQL | 16 → 21 | 0 → 48 | 385 → 332 |
| PostgreSQL | 47 → 47 | 0 → 408 | 644 → 236 |
| Trino | 62 → 65 | 0 → 320 | 373 → 52 |
| Impala | 10 → 16 | 0 → 146 | 238 → 86 |
| Generic | 6 → 9 | 0 → 16 | 43 → 34 |
| **Total** | **272 → 302** | **0 → 1236** | **2436 → 1194** |

There are now 644 reviewed and 894 documentation-generated runtime contracts.
The catalog gains 24 previously missing names, principally Hive window/MAP
functions, Trino conditional forms, and their Generic intersection. All function
producers in the 427 discovery regressions have reviewed or documented return
rules; the tests continue to assert concrete type families and container shapes.

The generated documentation metadata separately contains:

| Dialect | Complete extraction | Partial extraction | Name only |
| --- | ---: | ---: | ---: |
| Spark | 5 | 43 | 421 |
| Hive | 105 | 49 | 24 |
| Flink | 8 | 21 | 179 |
| MySQL | 2 | 23 | 358 |
| PostgreSQL | 206 | 227 | 233 |
| Trino | 81 | 250 | 104 |
| Impala | 117 | 8 | 66 |

Only unambiguously recognized signatures and return statements are promoted.
Name-only entries remain useful for completion but are not documented type
evidence. Future extractor improvements should update coverage floors without
turning incomplete prose into restrictive parameter contracts.
