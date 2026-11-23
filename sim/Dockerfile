# Headless Even Hub simulator runner (Linux x64).
# The simulator binary needs glibc >= 2.34 and WebKitGTK 4.1, so it runs in
# Ubuntu 24.04 on a virtual X display (Xvfb). Screenshots via ImageMagick.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-0 libgtk-3-0 libasound2t64 libayatana-appindicator3-1 \
      xvfb xauth imagemagick x11-utils xdotool \
      fonts-noto-cjk fonts-dejavu-core ca-certificates curl \
      pulseaudio pulseaudio-utils libasound2-plugins \
    && rm -rf /var/lib/apt/lists/*
# Route ALSA's default device through PulseAudio so a pipe source can act as
# a virtual microphone (see sim/smoke.sh, AUDIO=...).
RUN printf 'pcm.!default pulse\nctl.!default pulse\n' > /etc/asound.conf
WORKDIR /app
