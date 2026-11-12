"""Browser journeys for the sound settings of a call (issue #1244): devices, volumes, the level meter, the browser's switches and a
person's own volume, all local to the browser that sets them.

Runs only with ``FLUX_UI_LIVE=1`` against the pinned self-hosted SFU, through
``FLUX_LIVE_UI_PATTERN=test_live_audio.py scripts/check_live_ui.sh`` (or ``scripts/ci_test.sh <ref> live chromium test_live_audio``).
Real Chromium clients use Chromium's fake microphone, which beeps. The fake devices the settings list (two microphones and two
outputs besides the default) come from ``AUDIO_INSTRUMENT``: it replaces the audio lists, maps the fake microphones onto the real fake
one, and records every audio capture and every ``setSinkId`` call, because a headless browser has no output device to choose.

What is measured and what is not:

* The microphone volume is measured where it matters, on the receiver's own stream (a ScriptProcessor on the remote track): none at
  0 %, a quarter of the power at 50 %. Chromium's own fake microphone beeps at full scale, so above 100 % it can only clip; a second
  browser plays a quiet tone from a file instead (``--use-file-for-fake-audio-capture``), and there 200 % carries four times the power.
* The per-person volume is the playing element's own ``volume`` and ``muted`` (up to 100 %) or a gain stage (above), and no request
  leaves the browser when it changes.
* Output choice is the call made to ``setSinkId`` with the chosen id; nothing is heard in a headless browser.
* WebKit and physical devices are not covered here; the independent reviewer runs WebKit on the final head.
"""

from __future__ import annotations

import json
import math
import re
import struct
import tempfile
import unittest
import wave
from pathlib import Path

from playwright.sync_api import Browser, Locator, Page, expect

from test_app_shell import DESKTOP, ORIGIN, PHONE, shot
from test_live_sessions import INSTRUMENT, LIVE, LiveBase, PEOPLE

IPHONE_UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) "
             "Version/17.5 Mobile/15E148 Safari/604.1")

# Two fake microphones and two fake outputs besides the default, a record of what the page asked for, and no real output device to
# choose in a headless browser: setSinkId is recorded and answers. A fake microphone id is mapped onto the browser's own fake
# microphone, after it is recorded. `__gone` lists devices that are unplugged.
AUDIO_INSTRUMENT = """
(() => {
  const log = { gum: [], sinks: [], ctxSinks: [] };
  Object.defineProperty(window, '__audio', { value: log });
  window.__gone = [];
  const fakeIn = [['fake-mic-a', 'Fake microphone A'], ['fake-mic-b', 'Fake microphone B']];
  const fakeOut = [['fake-out-a', 'Fake speakers'], ['fake-out-b', 'Fake headphones']];
  const md = navigator.mediaDevices;
  if (md) {
    const enumerate = md.enumerateDevices.bind(md);
    const make = (kind, [deviceId, label]) => ({ deviceId, kind, label, groupId: deviceId, toJSON() { return { deviceId, kind, label }; } });
    md.enumerateDevices = async () => {
      const list = await enumerate();
      const here = (devices) => devices.filter(([id]) => !window.__gone.includes(id));
      return [
        ...list.filter((device) => device.kind === 'videoinput'),
        make('audioinput', ['default', 'Default']), ...here(fakeIn).map((device) => make('audioinput', device)),
        make('audiooutput', ['default', 'Default']), ...here(fakeOut).map((device) => make('audiooutput', device)),
      ];
    };
    const gum = md.getUserMedia.bind(md);
    md.getUserMedia = async (constraints) => {
      const audio = constraints && constraints.audio;
      if (audio) log.gum.push(typeof audio === 'object' ? JSON.stringify(audio) : 'true');
      const id = audio && typeof audio === 'object' && audio.deviceId && (audio.deviceId.exact || audio.deviceId.ideal || audio.deviceId);
      if (typeof id === 'string' && id.startsWith('fake-')) {
        if (window.__gone.includes(id)) throw new DOMException('Requested device not found', 'NotFoundError');
        const { deviceId, ...rest } = audio;
        constraints = { ...constraints, audio: rest };
      }
      return gum(constraints);
    };
  }
  const proto = window.HTMLMediaElement && HTMLMediaElement.prototype;
  if (proto && 'setSinkId' in proto) proto.setSinkId = function (id) { log.sinks.push({ id, tag: this.tagName }); return Promise.resolve(); };
  if (window.AudioContext && 'setSinkId' in AudioContext.prototype) AudioContext.prototype.setSinkId = function (id) { log.ctxSinks.push(id); return Promise.resolve(); };
})();
"""

# The mean power of what the first remote voice carries to this page, measured on the received stream itself, before the element's
# volume: every sample of the window counts (a ScriptProcessor sees all of them), so the short beeps of the fake microphone cannot be missed.
POWER = """async (ms) => {
  const element = document.querySelector('[data-live-audio] audio');
  const context = new AudioContext();
  await context.resume();
  const source = context.createMediaStreamSource(element.srcObject);
  const node = context.createScriptProcessor(1024, 1, 1);
  let sum = 0, count = 0, peak = 0, active = 0, buffers = 0, loudSum = 0, loudCount = 0;
  node.onaudioprocess = (event) => {
    const data = event.inputBuffer.getChannelData(0);
    let top = 0, energy = 0;
    for (let i = 0; i < data.length; i += 1) { energy += data[i] * data[i]; top = Math.max(top, Math.abs(data[i])); }
    sum += energy; count += data.length; buffers += 1; peak = Math.max(peak, top);
    if (top > 0.02) { active += 1; loudSum += energy; loudCount += data.length; }
  };
  source.connect(node);
  node.connect(context.destination);
  await new Promise((resolve) => setTimeout(resolve, ms));
  source.disconnect();
  node.disconnect();
  await context.close();
  return { power: count ? sum / count : 0, beep: loudCount ? loudSum / loudCount : 0, peak, active, buffers };
}"""

SET_RANGE = """(element, value) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, String(value));
  element.dispatchEvent(new Event('input', { bubbles: true }));
}"""


def set_range(slider: Locator, value: int) -> None:
    slider.evaluate(SET_RANGE, value)


def until(page: Page, condition: str, timeout: int = 15000) -> None:
    """Waits until a JavaScript condition holds in the page (the page's own state, not a locator)."""
    page.wait_for_function(condition, timeout=timeout)


def remembered(page: Page) -> dict:
    return json.loads(page.evaluate("localStorage.getItem('flux.live.audio') || '{}'"))


def voices(page: Page) -> list[dict]:
    return page.evaluate("[...document.querySelectorAll('[data-live-audio] audio')].map((e) => ({ volume: e.volume, muted: e.muted, gain: e.dataset.liveGain || null }))")


@unittest.skipUnless(LIVE, "needs the media server of the live test profile")
class LiveAudio(LiveBase):
    browser: Browser

    tone: Browser
    wav: Path

    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        # A quiet 440 Hz tone (amplitude 0.2) for one second and silence for half a second, repeated: 200 % of it is not clipped.
        cls.wav = Path(tempfile.gettempdir()) / "flux-quiet-tone.wav"
        with wave.open(str(cls.wav), "wb") as out:
            out.setnchannels(1)
            out.setsampwidth(2)
            out.setframerate(48000)
            tone = [int(0.2 * 32767 * math.sin(2 * math.pi * 440 * n / 48000)) for n in range(48000)]
            out.writeframes(struct.pack(f"<{len(tone)}h", *tone) + b"\x00\x00" * 24000)
        cls.tone = cls.pw.chromium.launch(args=[
            "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", f"--use-file-for-fake-audio-capture={cls.wav}",
        ])

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tone.close()
        super().tearDownClass()

    def context(self, who, **kwargs):  # type: ignore[override]
        context = super().context(who, **kwargs)
        context.add_init_script(AUDIO_INSTRUMENT)
        return context

    def page_on(self, browser: Browser, who: str, **options) -> Page:
        """A page of this person in another browser (the tone browser) or another kind of device (an iPhone's user agent)."""
        base = {"base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw", "viewport": DESKTOP,
                "device_scale_factor": 1, "storage_state": self.states[who]}
        context = browser.new_context(**{**base, **options})
        context.grant_permissions(["microphone", "camera"], origin=ORIGIN)
        context.add_init_script(INSTRUMENT)
        context.add_init_script(AUDIO_INSTRUMENT)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def ios_page(self, who: str) -> Page:
        """The phone as an iPhone: the page recognises iOS by its user agent (no media volume, no output choice)."""
        return self.page_on(self.browser, who, viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True, user_agent=IPHONE_UA)

    def start_call(self, nia: Page, jonas: Page) -> None:
        self.open_conversation(nia)
        nia.locator("header.top, header.phead").get_by_role("button", name="Call").click()
        expect(self.bar(nia)).to_be_visible()
        self.open_conversation(jonas)
        jonas.locator("header.top, header.phead").get_by_role("button", name="Join").click()
        expect(self.bar(jonas)).to_be_visible()
        expect(self.bar(nia).locator(".lv-face")).to_have_count(2)

    def test_01_devices_volumes_meter_and_a_persons_own_volume(self) -> None:
        self.seed()
        nia, jonas = self.page("nia"), self.page("jonas")
        self.start_call(nia, jonas)
        nbar, jbar = self.bar(nia), self.bar(jonas)
        self.assertEqual(nia.evaluate("window.__audio.gum.length"), 0, "joining captures nothing")

        # The arrow beside the microphone opens Audio settings; while the microphone is off the meter listens locally (the browser
        # already allows it), says so, and stops the moment the settings close.
        arrow = nbar.get_by_role("button", name="Audio settings")
        expect(arrow).to_have_attribute("aria-haspopup", "dialog")
        arrow.click()
        dialog = nia.get_by_role("dialog", name="Audio settings")
        expect(dialog).to_be_visible()
        expect(dialog.get_by_role("heading", name="Audio", level=2)).to_be_visible()
        expect(dialog.get_by_role("combobox", name="Microphone")).to_be_focused()
        expect(dialog.get_by_role("img", name=re.compile("^Microphone level: "))).to_be_visible()
        expect(dialog).to_contain_text("Only you hear this check. Nothing is sent.")
        self.assertEqual(nia.evaluate("window.__audio.gum.length"), 1, "the meter's own capture, never published")
        expect(nbar.get_by_role("button", name=re.compile("^Microphone off"))).to_have_attribute("aria-pressed", "false")
        # The meter moves with the fake microphone's beeps and its word is the text alternative.
        meter = dialog.get_by_role("img", name=re.compile("^Microphone level: "))
        expect(meter).to_have_attribute("aria-label", "Microphone level: Speaking", timeout=20000)
        levels = nia.evaluate("""async () => {
          const fill = document.querySelector('.lv-meter__fill'); const seen = [];
          for (let i = 0; i < 120; i += 1) { seen.push(parseFloat(getComputedStyle(fill).getPropertyValue('--level') || '0')); await new Promise((r) => setTimeout(r, 25)); }
          return seen; }""")
        self.assertGreater(max(levels), 0.2, "the meter fills while the fake microphone beeps")
        self.assertGreater(max(levels) - min(levels), 0.15, "and falls between beeps")
        shot(nia, "live-audio-desktop-1440-light")
        nia.emulate_media(color_scheme="dark")
        shot(nia, "live-audio-desktop-1440-dark")
        nia.emulate_media(color_scheme="light")
        nia.keyboard.press("Escape")
        expect(dialog).to_be_hidden()
        expect(arrow).to_be_focused()
        ended = nia.evaluate("window.__live.tracks.filter((t) => t.kind === 'audio').every((t) => t.readyState === 'ended')")
        self.assertTrue(ended, "closing the settings stops the meter's capture")

        # The microphone on, and both ways of hearing each other.
        nbar.get_by_role("button", name=re.compile("^Microphone off")).click()
        expect(nbar.get_by_role("button", name=re.compile("^Microphone on"))).to_have_attribute("aria-pressed", "true")
        jbar.get_by_role("button", name=re.compile("^Microphone off")).click()
        expect(jbar.get_by_role("button", name=re.compile("^Microphone on"))).to_have_attribute("aria-pressed", "true")
        expect(jonas.locator("[data-live-audio] audio")).to_have_count(1)
        expect(nia.locator("[data-live-audio] audio")).to_have_count(1)

        # Browser switches: all three on by default; turning one off restarts the running capture with it.
        arrow.click()
        expect(dialog).to_be_visible()
        for name in ("Reduce background noise", "Cancel echo", "Even out my volume"):
            expect(dialog.get_by_role("switch", name=name)).to_have_attribute("aria-checked", "true")
        captures = nia.evaluate("window.__audio.gum.length")
        for name in ("Reduce background noise", "Cancel echo", "Even out my volume"):
            dialog.get_by_role("switch", name=name).click()
            expect(dialog.get_by_role("switch", name=name)).to_have_attribute("aria-checked", "false")
        until(nia, f"window.__audio.gum.length >= {captures + 3}")
        expect(nbar.get_by_role("button", name=re.compile("^Microphone on"))).to_have_attribute("aria-pressed", "true")
        last = json.loads(nia.evaluate("window.__audio.gum.at(-1)"))
        self.assertEqual((last["echoCancellation"], last["noiseSuppression"], last["autoGainControl"]), (False, False, False))
        stored = remembered(nia)
        self.assertEqual((stored["echoCancellation"], stored["noiseSuppression"], stored["autoGain"]), (False, False, False))

        # Choosing another fake microphone captures it, keeps sending, and is remembered.
        captures = nia.evaluate("window.__audio.gum.length")
        dialog.get_by_role("combobox", name="Microphone").click()
        nia.get_by_role("option", name="Fake microphone B").click()
        expect(dialog.get_by_role("combobox", name="Microphone")).to_contain_text("Fake microphone B")
        until(nia, f"window.__audio.gum.length > {captures}")
        self.assertIn('"deviceId":{"exact":"fake-mic-b"}', nia.evaluate("window.__audio.gum.at(-1)"))
        expect(nbar.get_by_role("button", name=re.compile("^Microphone on"))).to_have_attribute("aria-pressed", "true")
        self.assertEqual(remembered(nia)["micId"], "fake-mic-b")

        # The microphone volume is what the other person receives: 0 %, 100 % and 200 % measured on Jonas's received stream.
        slider = dialog.get_by_role("slider", name="Microphone volume")
        expect(slider).to_have_attribute("aria-valuetext", "100%")
        nia.wait_for_timeout(1500)
        measured: dict[int, dict] = {}
        for index, percent in enumerate((100, 0, 50, 200, 150)):
            if index:
                set_range(slider, percent)
                expect(slider).to_have_attribute("aria-valuetext", f"{percent}%")
                nia.wait_for_timeout(1500)
            measured[percent] = jonas.evaluate(POWER, 5000)
            print(f"receiver at {percent} %: {measured[percent]}")
        base, silent, half = (measured[key]["power"] for key in (100, 0, 50))
        self.assertGreater(base, 1e-6, "the fake microphone is heard before any change")
        self.assertLess(silent, base * 0.02, "0 % is silence for the receiver")
        # While a beep sounds (the buffers that are not silent), 50 % carries a fraction of the power of 100 %. The fake microphone's beep is
        # at full scale (peak about 1), so above 100 % it can only clip: it is not quieter. The quiet tone of the next test measures the boost.
        self.assertLess(measured[50]["beep"], measured[100]["beep"] * 0.6, "50 % is quieter than 100 %")
        self.assertLess(measured[50]["peak"], measured[100]["peak"] * 0.8, "and its peak is lower")
        for percent in (150, 200):
            self.assertGreater(measured[percent]["beep"], measured[100]["beep"] * 0.9, f"{percent} % is not quieter than 100 %")
        set_range(slider, 200)
        expect(slider).to_have_attribute("aria-valuetext", "200%")
        self.assertEqual(remembered(nia)["micVolume"], 200)
        set_range(slider, 120)
        expect(slider).to_have_attribute("aria-valuetext", "120%")
        # The slider is a real range input: the keyboard moves it too.
        slider.focus()
        nia.keyboard.press("ArrowRight")
        expect(slider).to_have_attribute("aria-valuetext", "121%")
        nia.keyboard.press("Home")
        expect(slider).to_have_attribute("aria-valuetext", "0%")
        set_range(slider, 120)

        # Speakers: choosing one calls setSinkId with its id on the playing voice; Test sound plays at the chosen volume.
        out = dialog.get_by_role("combobox", name="Speakers or headphones")
        out.click()
        nia.get_by_role("option", name="Fake headphones").click()
        expect(out).to_contain_text("Fake headphones")
        until(nia, "window.__audio.sinks.some((sink) => sink.id === 'fake-out-b')")
        self.assertIn("AUDIO", [item["tag"] for item in nia.evaluate("window.__audio.sinks") if item["id"] == "fake-out-b"])
        self.assertEqual(remembered(nia)["speakerId"], "fake-out-b")
        before = len(nia.evaluate("window.__audio.sinks"))
        dialog.get_by_role("button", name="Test sound").click()
        expect(dialog.get_by_role("button", name="Playing…")).to_be_visible()
        self.assertGreater(len(nia.evaluate("window.__audio.sinks")), before, "the test sound plays through the chosen speakers")
        self.assertEqual(nia.evaluate("window.__audio.sinks.at(-1).id"), "fake-out-b")
        expect(dialog.get_by_role("button", name="Test sound")).to_be_visible()

        # Everything you hear lowers every voice on this device only.
        master = dialog.get_by_role("slider", name="Everything you hear")
        expect(master).to_have_attribute("aria-valuetext", "100%")
        set_range(master, 50)
        until(nia, "Math.abs(document.querySelector('[data-live-audio] audio').volume - 0.5) < 0.01")
        self.assertAlmostEqual(voices(nia)[0]["volume"], 0.5, delta=0.01)
        self.assertEqual(voices(jonas)[0]["volume"], 1, "nobody else's sound changed")
        shot(nia, "live-audio-desktop-1440-light-changed")
        set_range(master, 100)
        nia.keyboard.press("Escape")
        expect(dialog).to_be_hidden()

        # A person's own volume: Jonas on Nia. Only the playing element changes, nothing leaves the browser, and nobody is told.
        requests: list[str] = []
        jonas.on("request", lambda request: requests.append(f"{request.method} {request.url}") if request.method != "GET" and "/api/" in request.url else None)
        face = jbar.get_by_role("button", name="Sound from Nia Okafor")
        expect(face).to_have_attribute("aria-haspopup", "dialog")
        expect(jbar.get_by_role("button", name=re.compile("^Sound from Jonas"))).to_have_count(0)
        face.click()
        person = jonas.get_by_role("dialog", name="Sound from Nia Okafor")
        expect(person).to_be_visible()
        expect(person).to_contain_text("Only you hear this change.")
        shot(jonas, "live-audio-desktop-1440-light-person")
        jonas.emulate_media(color_scheme="dark")
        shot(jonas, "live-audio-desktop-1440-dark-person")
        jonas.emulate_media(color_scheme="light")
        volume = person.get_by_role("slider", name="Volume")
        expect(volume).to_have_attribute("aria-valuetext", "100%")
        requests.clear()
        set_range(volume, 80)
        expect(volume).to_have_attribute("aria-valuetext", "80%")
        until(jonas, "Math.abs(document.querySelector('[data-live-audio] audio').volume - 0.8) < 0.01")
        self.assertAlmostEqual(voices(jonas)[0]["volume"], 0.8, delta=0.01)
        self.assertEqual(voices(nia)[0]["volume"], 1, "Nia's playback of Jonas is untouched")
        self.assertEqual(requests, [], "a person's volume writes nothing to the server")
        self.assertEqual(person.get_by_role("switch", name="Mute for me").get_attribute("aria-checked"), "false")
        person.get_by_role("switch", name="Mute for me").click()
        expect(person.get_by_role("switch", name="Mute for me")).to_have_attribute("aria-checked", "true")
        self.assertTrue(voices(jonas)[0]["muted"], "muted for me is the element's own")
        self.assertFalse(voices(nia)[0]["muted"])
        self.assertEqual(requests, [], "muting for me writes nothing to the server")
        expect(nbar.get_by_role("button", name=re.compile("^Microphone on"))).to_have_attribute("aria-pressed", "true")
        expect(jbar.get_by_role("button", name="Sound from Nia Okafor, muted for you")).to_be_visible()
        person.get_by_role("switch", name="Mute for me").click()
        self.assertFalse(voices(jonas)[0]["muted"])
        # Above 100 % the voice goes through a gain stage and its element is silent, so it is never heard twice.
        set_range(volume, 200)
        expect(volume).to_have_attribute("aria-valuetext", "200%")
        until(jonas, "document.querySelector('[data-live-audio] audio').dataset.liveGain === '2'")
        self.assertTrue(voices(jonas)[0]["muted"])
        set_range(volume, 150)
        until(jonas, "document.querySelector('[data-live-audio] audio').dataset.liveGain === '1.5'")
        set_range(volume, 80)
        until(jonas, "!document.querySelector('[data-live-audio] audio').dataset.liveGain")
        self.assertFalse(voices(jonas)[0]["muted"])
        self.assertAlmostEqual(voices(jonas)[0]["volume"], 0.8, delta=0.01)
        self.assertEqual(remembered(jonas)["people"].get(PEOPLE["nia"]["id"]), {"volume": 80, "muted": False})
        jonas.keyboard.press("Escape")

        # The same two controls are in ⋯, so a device without the strip's faces reaches them.
        jbar.get_by_role("button", name="Session details and more").click()
        panel = jonas.get_by_role("dialog", name="Live session")
        row = panel.locator(".lv-person", has_text="Nia Okafor")
        row.get_by_role("button", name="Sound from Nia Okafor").click()
        inline = row.locator(".lv-person__sound")
        expect(inline.get_by_role("slider", name="Volume")).to_have_attribute("aria-valuetext", "80%")
        expect(inline.get_by_role("switch", name="Mute for me")).to_be_visible()
        expect(panel.get_by_role("button", name="Audio settings")).to_be_visible()
        jonas.keyboard.press("Escape")

        # Remembered: leave, reload the page (a new connection reads the device's storage), join again.
        nbar.get_by_role("button", name="Leave", exact=True).click()
        expect(nbar).to_have_count(0)
        nia.reload()
        self.open_conversation(nia)
        nia.locator("header.top, header.phead").get_by_role("button", name="Join").click()
        expect(self.bar(nia)).to_be_visible()
        self.assertEqual(nia.evaluate("window.__audio.gum.length"), 0, "joining again captures nothing")
        self.bar(nia).get_by_role("button", name=re.compile("^Microphone off")).click()
        expect(self.bar(nia).get_by_role("button", name=re.compile("^Microphone on"))).to_have_attribute("aria-pressed", "true")
        started = json.loads(nia.evaluate("window.__audio.gum.at(-1)"))
        self.assertEqual(started["deviceId"], {"exact": "fake-mic-b"}, "the remembered microphone starts")
        self.assertEqual((started["echoCancellation"], started["noiseSuppression"], started["autoGainControl"]), (False, False, False))
        until(nia, "window.__audio.sinks.some((sink) => sink.id === 'fake-out-b')")
        self.bar(nia).get_by_role("button", name="Audio settings").click()
        again = nia.get_by_role("dialog", name="Audio settings")
        expect(again.get_by_role("combobox", name="Microphone")).to_contain_text("Fake microphone B")
        expect(again.get_by_role("combobox", name="Speakers or headphones")).to_contain_text("Fake headphones")
        expect(again.get_by_role("slider", name="Microphone volume")).to_have_attribute("aria-valuetext", "120%")
        expect(again.get_by_role("switch", name="Cancel echo")).to_have_attribute("aria-checked", "false")
        # The microphone volume applies at the start too: 120 % is a gain stage in the running capture.
        expect(self.bar(jonas).get_by_role("button", name="Sound from Nia Okafor")).to_be_visible()
        nia.wait_for_timeout(1500)

        # A device that disappears (unplugged headphones): the default, and one calm sentence; the remembered id is dropped.
        nia.evaluate("window.__gone = ['fake-out-b']; navigator.mediaDevices.dispatchEvent(new Event('devicechange'))")
        expect(again.get_by_role("status").filter(has_text="“Fake headphones” was disconnected. Sound plays through the default output.")).to_be_visible()
        expect(again.get_by_role("combobox", name="Speakers or headphones")).to_contain_text("Default")
        expect(nia.get_by_text("“Fake headphones” was disconnected.").first).to_be_visible()
        self.assertIsNone(remembered(nia)["speakerId"])
        self.assertEqual(nia.evaluate("window.__audio.sinks.at(-1).id"), "default")
        nia.keyboard.press("Escape")
        for strip in (self.bar(nia), self.bar(jonas)):
            strip.get_by_role("button", name="Leave", exact=True).click()
            expect(strip).to_have_count(0)

    def test_02_the_phone_reaches_the_same_settings_from_more_and_an_iphone_uses_its_buttons(self) -> None:
        self.seed()
        nia = self.page("nia")
        self.open_conversation(nia)
        # The call of the first test may still be joinable for a moment after everyone left: Join then, Call otherwise.
        nia.locator("header.top, header.phead").get_by_role("button", name=re.compile("^(Call|Join)$")).click()
        expect(self.bar(nia)).to_be_visible()

        # An Android-sized phone (Chromium): ⋯ opens the sheet, its Audio settings row opens the same settings as a sheet, with the
        # output choice and both volumes; the phone's strip has no arrow beside the microphone.
        ada = self.page("ada", phone=True)
        self.open_conversation(ada)
        ada.locator("header.top, header.phead").get_by_role("button", name="Join").click()
        expect(self.bar(ada)).to_be_visible()
        expect(self.bar(ada).get_by_role("button", name="Audio settings")).to_have_count(0)
        self.bar(ada).get_by_role("button", name="Session details and more").click()
        ada.get_by_role("dialog", name="Live session").get_by_role("button", name="Audio settings").click()
        android = ada.get_by_role("dialog", name="Audio settings")
        expect(android).to_be_visible()
        expect(android.get_by_role("combobox", name="Speakers or headphones")).to_be_visible()
        expect(android.get_by_role("slider", name="Everything you hear")).to_be_visible()
        expect(android.get_by_role("slider", name="Microphone volume")).to_be_visible()
        self.assertEqual(ada.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth"), 0, "no sideways scroll at 390")
        shot(ada, "live-audio-phone-390-light")
        ada.emulate_media(color_scheme="dark")
        shot(ada, "live-audio-phone-390-dark")
        ada.emulate_media(color_scheme="light")
        android.get_by_role("button", name="Close audio settings").click()
        expect(android).to_be_hidden()
        self.bar(ada).get_by_role("button", name="Leave", exact=True).click()
        expect(self.bar(ada)).to_have_count(0)

        jonas = self.ios_page("jonas")
        self.open_conversation(jonas)
        jonas.locator("header.top, header.phead").get_by_role("button", name="Join").click()
        bar = self.bar(jonas)
        expect(bar).to_be_visible()
        expect(bar.get_by_role("button", name="Audio settings")).to_have_count(0)
        for button in bar.get_by_role("button").all():
            box = button.bounding_box()
            assert box
            self.assertGreaterEqual(min(box["width"], box["height"]), 43.5, f"touch target {button.get_attribute('aria-label') or button.inner_text()}")
        self.bar(nia).get_by_role("button", name=re.compile("^Microphone off")).click()
        expect(jonas.locator("[data-live-audio] audio")).to_have_count(1)

        bar.get_by_role("button", name="Session details and more").click()
        sheet = jonas.get_by_role("dialog", name="Live session")
        row = sheet.locator(".lv-person", has_text="Nia Okafor")
        row.get_by_role("button", name="Sound from Nia Okafor").click()
        inline = row.locator(".lv-person__sound")
        # An iPhone cannot set the media volume: only Mute for me is offered for a person.
        expect(inline.get_by_role("switch", name="Mute for me")).to_be_visible()
        expect(inline.get_by_role("slider")).to_have_count(0)
        shot(jonas, "live-audio-phone-390-person-ios")
        inline.get_by_role("switch", name="Mute for me").click()
        expect(inline.get_by_role("switch", name="Mute for me")).to_have_attribute("aria-checked", "true")
        self.assertTrue(voices(jonas)[0]["muted"], f"muted for me is the element's own: {voices(jonas)} {remembered(jonas)}")
        inline.get_by_role("switch", name="Mute for me").click()
        expect(inline.get_by_role("switch", name="Mute for me")).to_have_attribute("aria-checked", "false")
        sheet.get_by_role("button", name="Audio settings").click()
        audio = jonas.get_by_role("dialog", name="Audio settings")
        expect(audio).to_be_visible()
        expect(audio.get_by_role("heading", name="Audio", level=2)).to_be_visible()
        expect(audio.get_by_role("combobox", name="Microphone")).to_be_visible()
        expect(audio.get_by_role("slider", name="Microphone volume")).to_be_visible()
        # The output choice and the volume are not drawn; one line says why, and Test sound stays.
        expect(audio.get_by_role("combobox", name="Speakers or headphones")).to_have_count(0)
        expect(audio.get_by_role("slider", name="Everything you hear")).to_have_count(0)
        expect(audio).to_contain_text("Use your phone’s volume buttons.")
        expect(audio.get_by_role("button", name="Test sound")).to_be_visible()
        self.assertEqual(jonas.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth"), 0, "no sideways scroll at 390")
        shot(jonas, "live-audio-phone-390-light-ios")
        jonas.emulate_media(color_scheme="dark")
        shot(jonas, "live-audio-phone-390-dark-ios")
        jonas.emulate_media(color_scheme="light")
        # The sheet closes with its own close control (a phone has no Escape), and the strip is where it was.
        audio.get_by_role("button", name="Close audio settings").click()
        expect(audio).to_be_hidden()
        for page in (self.bar(jonas), self.bar(nia)):
            page.get_by_role("button", name="Leave", exact=True).click()
            expect(page).to_have_count(0)


    def test_03_above_100_percent_the_microphone_is_louder_for_the_other_person(self) -> None:
        """A quiet fake microphone (a tone from a file) is not clipped at 200 %: the receiver gets about four times the power."""
        self.seed()
        nia = self.page_on(self.tone, "nia")
        jonas = self.page("jonas")
        self.open_conversation(nia)
        nia.locator("header.top, header.phead").get_by_role("button", name=re.compile("^(Call|Join)$")).click()
        expect(self.bar(nia)).to_be_visible()
        self.open_conversation(jonas)
        jonas.locator("header.top, header.phead").get_by_role("button", name=re.compile("^(Call|Join)$")).click()
        expect(self.bar(jonas)).to_be_visible()
        self.bar(nia).get_by_role("button", name=re.compile("^Microphone off")).click()
        expect(self.bar(nia).get_by_role("button", name=re.compile("^Microphone on"))).to_have_attribute("aria-pressed", "true")
        expect(jonas.locator("[data-live-audio] audio")).to_have_count(1)
        self.bar(nia).get_by_role("button", name="Audio settings").click()
        dialog = nia.get_by_role("dialog", name="Audio settings")
        expect(dialog).to_be_visible()
        # The browser's own processing would treat a steady tone as noise: switched off, the tone is what is sent.
        captures = nia.evaluate("window.__audio.gum.length")
        for name in ("Reduce background noise", "Cancel echo", "Even out my volume"):
            dialog.get_by_role("switch", name=name).click()
        until(nia, f"window.__audio.gum.length >= {captures + 3}")
        slider = dialog.get_by_role("slider", name="Microphone volume")
        measured: dict[int, dict] = {}
        nia.wait_for_timeout(1500)
        for index, percent in enumerate((100, 200, 50, 0)):
            if index:
                set_range(slider, percent)
                expect(slider).to_have_attribute("aria-valuetext", f"{percent}%")
                nia.wait_for_timeout(1500)
            measured[percent] = jonas.evaluate(POWER, 6000)
            print(f"receiver of the quiet tone at {percent} %: {measured[percent]}")
        base = measured[100]["beep"]
        self.assertGreater(base, 1e-4, "the quiet tone is heard")
        self.assertLess(measured[100]["peak"], 0.5, "and it is far from full scale at 100 %")
        self.assertGreater(measured[200]["beep"], base * 3, "200 % carries about four times the power")
        self.assertLess(measured[200]["beep"], base * 5)
        self.assertGreater(measured[200]["peak"], measured[100]["peak"] * 1.6, "and about twice the amplitude")
        self.assertGreater(measured[50]["beep"], base * 0.15, "50 % carries about a quarter")
        self.assertLess(measured[50]["beep"], base * 0.4)
        self.assertEqual(measured[0]["peak"], 0, "0 % is silence")
        nia.keyboard.press("Escape")
        for strip in (self.bar(nia), self.bar(jonas)):
            strip.get_by_role("button", name="Leave", exact=True).click()
            expect(strip).to_have_count(0)


if __name__ == "__main__":
    unittest.main()
