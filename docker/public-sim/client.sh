#!/bin/sh
# A simulated client computer (#63): its only route is the NAT router, its only resolver the
# simulation's DNS, and it trusts the simulation's CA like an installed root. Usage: client.sh ROUTER_IP
#
# It also has the synthetic media of the measured profiles (docs/development/live-media.md, "Measured profiles"):
#   /media/camera-1080p30.y4m  the camera of a Chromium person with fake devices (1920x1080, 30 fps);
#   /media/speech.wav          continuous synthetic speech, the microphone of a Chromium person with fake devices;
#   a PulseAudio microphone that plays the same speech, for a browser without fake devices (a person who shares
#   a real screen); and an X display (:99, 1920x1080, no RandR: Chromium's X11 screen capturer then accepts the
#   whole screen) that `screen-source.sh on` fills with SCREEN, a moving test pattern.
set -eu
router=$1
ip route replace default via "$router"
printf 'nameserver 203.0.113.53\n' > /etc/resolv.conf
cp /certs/ca.crt /usr/local/share/ca-certificates/flux-sim-ca.crt
update-ca-certificates >/dev/null 2>&1
mkdir -p /root/.pki/nssdb
[ -f /root/.pki/nssdb/cert9.db ] || certutil -N -d sql:/root/.pki/nssdb --empty-password
certutil -A -d sql:/root/.pki/nssdb -n flux-sim-ca -t 'C,,' -i /certs/ca.crt
export NODE_EXTRA_CA_CERTS=/certs/ca.crt

mkdir -p /media
# Two seconds of the camera, looped by Chromium; testsrc2 moves everywhere in the frame (a worst case for a camera).
ffmpeg -loglevel error -y -f lavfi -i "testsrc2=size=1920x1080:rate=30" -t 2 -pix_fmt yuv420p /media/camera-1080p30.y4m
# About 40 s of continuous speech at 48 kHz mono, looped by Chromium and by the PulseAudio microphone.
espeak-ng -s 160 -w /tmp/speech-raw.wav "Good morning everyone. Today we review the gesture lamp. The prototype \
reads a hand above the shade and dims the light to match. Night frames were black because the sensor slept \
between readings. We changed the sleep interval, rebuilt the firmware and tested it again on the bench. \
The second change is the calibration step: the lamp now learns the room when it starts, so a bright window \
no longer confuses it. Next week we test three lamps in the workshop and write down what people notice."
ffmpeg -loglevel error -y -i /tmp/speech-raw.wav -ar 48000 -ac 1 -sample_fmt s16 /media/speech.wav

Xvfb :99 -screen 0 1920x1080x24 -extension RANDR -nolisten tcp >/tmp/xvfb.log 2>&1 &
pulseaudio -D --exit-idle-time=-1 >/tmp/pulse.log 2>&1 || true
for attempt in 1 2 3 4 5 6 7 8 9 10; do pactl info >/dev/null 2>&1 && break; sleep 0.5; done
pactl load-module module-null-sink sink_name=speech >/dev/null
# A real input (Chromium lists no monitor sources): the speech sink remapped as a microphone.
pactl load-module module-remap-source master=speech.monitor source_name=speechmic source_properties=device.description=Speech >/dev/null
pactl set-default-source speechmic
(while :; do paplay -d speech --volume=32768 /media/speech.wav || sleep 1; done) >/dev/null 2>&1 &
export DISPLAY=:99
exec python3 -m playwright run-server --port 3000 --host 0.0.0.0 --unsafe
