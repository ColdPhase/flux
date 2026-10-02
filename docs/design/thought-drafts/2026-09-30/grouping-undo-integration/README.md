# Confirmed draft and hierarchy-undo integration

Tested source `8cd069c58d88fac0d01e4d300cecc7948b99d5df`; subsequent accepted-main/#148 integration `fc20263f9e7ebdabc55942606164adb26e5de35c` changes only ancestry and documentation. Application, tests, dependencies and infrastructure are byte-identical across that checkpoint.

Isolated Docker build/type/lint and **17/17 actual browser journeys passed in 42.297s**: nine create/edit/recovery draft cases and eight stable outline/grouping cases, including the later-child/exact absent-null undo regression. Draft creation keeps shared graph empty until confirmation; failed/uncertain saves retain private text and stable retry identity; current two-author version conflict stays recoverable. [Log](docker-seventeen-journeys.txt), [manifest](manifest.json) and current screenshots retain the actual source. Resources were removed.

Previous independently accepted recovery wrapping and palette/landing assessments remain scoped to their supplied frames. The new grouping undo changes behavior only. #136/Agents shared-shell continuity and eligible independent functional approval remain required; PR158 stays draft. The old 131-pass/4-skip full run is retained at its old source and is not relabeled as current.
