"""F-037 (#874): the first account on a server sets up its company and owns its Everyone space.

scripts/check_ui.sh runs this once before the browser checks, so no test's own people take that role by being first.
"""

from __future__ import annotations

import json
import os
import urllib.request

ORIGIN = os.environ["FLUX_UI_ORIGIN"].rstrip("/")
UPSTREAM = os.environ["FLUX_UI_UPSTREAM"]

request = urllib.request.Request(
    f"http://{UPSTREAM}/api/auth/sign-up/email", method="POST",
    headers={"origin": ORIGIN, "content-type": "application/json"},
    data=json.dumps({"email": "company-setup@example.test", "password": "company setup for the checks", "name": "Company Setup"}).encode())
with urllib.request.urlopen(request, timeout=60) as response:
    assert response.status == 200, response.status
print("company set up by company-setup@example.test")
