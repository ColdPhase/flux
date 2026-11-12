# Browser tests for the web app (tests/ui). The base image carries Chromium and its system
# libraries for Playwright 1.62.0; only the matching Python client is added, pinned by hash.
FROM mcr.microsoft.com/playwright/python:v1.65.1-noble@sha256:0ab41a37431309d72b7a26f40ef1fdb464a62740196b2143965a2f59dc090409
COPY tests/ui/requirements.txt /tmp/ui-requirements.txt
RUN pip install --no-cache-dir --break-system-packages --only-binary=:all: --require-hashes -r /tmp/ui-requirements.txt
WORKDIR /work
# The tests are copied into the image rather than bind-mounted, so no host-specific relabeling
# (SELinux) or permissions are involved. check_ui.sh rebuilds this image on every run.
COPY tests/ui tests/ui
# discover (not a file path) so every test_*.py module runs; unittest exits non-zero if none ran.
CMD ["python3", "-m", "unittest", "discover", "-s", "tests/ui", "-p", "test_*.py", "-v"]
