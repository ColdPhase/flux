"""Current map input identity; visible paint remains the latency driver's separate observation."""


async def map_input_identity(page):
    # Resolve afresh after each trusted pointer input. Locator.evaluate also waits for an
    # attached handle and computes visibility; no geometry is needed for this identity read.
    return await page.evaluate("""() => {
      const canvases = document.querySelectorAll('.sk-canvas');
      if (canvases.length !== 1 || !canvases[0].isConnected)
        throw new Error('Expected exactly one connected current map canvas');
      const el = canvases[0];
      return {gestureId:el.dataset.liveOwnGesture,generation:el.dataset.liveGeneration,
        sequence:Number(el.dataset.liveOwnSequence),visibility:document.visibilityState};
    }""")
