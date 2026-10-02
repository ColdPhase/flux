# Measuring the 11.6 design system

These scripts produced [measured-design-system.md](../../inspection/measured-design-system.md)
on 2026-10-02. They serve the unchanged supplied HTML on container loopback and read
computed styles with Playwright 1.62 / Chromium, with no network.

Run from the repository root. `pylib` must contain the Python Playwright client pinned in
`app/tests/ui/requirements.txt`; install it once with network access, then measure without it:

```sh
out=$(mktemp -d); cp docs/design/references/studio-v11.6/tools/measure/*.py "$out"
cp -r docs/design/references/studio-v11.6/supplied "$out/supplied"
docker run --rm -v "$out:/out:z" -w /out mcr.microsoft.com/playwright/python:v1.62.0-noble \
  pip install --target /out/pylib -r /dev/stdin < app/tests/ui/requirements.txt
docker run --rm --network none --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$out:/out:z" -w /out \
  mcr.microsoft.com/playwright/python:v1.62.0-noble python3 extract.py
```

Output: `$out/measured.json` (every computed value) and `$out/shots/`. The fonts named by the
prototype are not installed in the image, so sizes, weights and line-heights are exact while
text widths are approximate.
