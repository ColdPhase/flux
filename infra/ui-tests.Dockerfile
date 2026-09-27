# Browser tests for the web app (tests/ui). The base image carries Chromium and its system
# libraries for Playwright 1.62.0; only the matching Python client is added, pinned by hash.
FROM mcr.microsoft.com/playwright/python:v1.62.0-noble@sha256:aa81288e738725378becba5b3e06cb0f3a7f012a610e87e8d767a090ea3f740d
COPY tests/ui/requirements.txt /tmp/ui-requirements.txt
RUN pip install --no-cache-dir --break-system-packages --only-binary=:all: --require-hashes -r /tmp/ui-requirements.txt
WORKDIR /work
# The tests are copied into the image rather than bind-mounted, so no host-specific relabeling
# (SELinux) or permissions are involved. check_ui.sh rebuilds this image on every run.
COPY tests/ui tests/ui
# discover (not a file path) so every test_*.py module runs; unittest exits non-zero if none ran.
CMD ["python3", "-m", "unittest", "discover", "-s", "tests/ui", "-p", "test_*.py", "-v"]
