"""Use CHROMIUM_PATH, system Chromium, or Playwright-managed Chromium."""
import os
import shutil

def launch(playwright):
    executable=os.environ.get("CHROMIUM_PATH") or shutil.which("chromium")
    options={"headless":True,"args":["--no-sandbox"]}
    if executable:
        options["executable_path"]=executable
    return playwright.chromium.launch(**options)
