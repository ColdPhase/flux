Three 2-second, 160 x 90 test clips for the video tests (#1352, C-61), made once with ffmpeg 7.1.1 (`mwader/static-ffmpeg:7.1.1`):

- `clip.mp4`: H.264 baseline and AAC, `moov` first (`-movflags +faststart`), so the playing time is in the first bytes.
- `clip.webm`: VP9 and Opus.
- `clip.mov`: H.264 baseline, no audio, `ftyp` brand `qt  `.

```
testsrc2=size=160x90:rate=10:duration=2
mp4:  -c:v libx264 -profile:v baseline -pix_fmt yuv420p -preset veryslow -crf 30 -c:a aac -b:a 24k -shortest -movflags +faststart
webm: -c:v libvpx-vp9 -b:v 60k -crf 40 -pix_fmt yuv420p -c:a libopus -b:a 16k -shortest
mov:  -c:v libx264 -profile:v baseline -pix_fmt yuv420p -preset veryslow -crf 30 -an -f mov
```

The browsers of the test images decode what their build has: record what each one plays in the PR that runs the UI tests.
