FROM nginx:1.29.4

ARG MEDIAMTX_VERSION=1.18.1
ARG GO2RTC_VERSION=1.9.14

ENV DEBIAN_FRONTEND=noninteractive \
    WEB_URL=https://www.baidu.com \
    STREAM_NAME=screen01 \
    WIDTH=1280 \
    HEIGHT=720 \
    FPS=15 \
    DISPLAY_ID=99 \
    MEDIAMTX_RTSP_PORT=8556 \
    GO2RTC_RTSP_PORT=554 \
    GO2RTC_API_PORT=80 \
    GO2RTC_WEBRTC_PORT=8555 \
    CHROME_BIN=/opt/google/chrome/chrome

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      dumb-init \
      ffmpeg \
      fonts-liberation \
      fonts-noto-cjk \
      fonts-noto-color-emoji \
      gnupg \
      openbox \
      procps \
      x11-utils \
      xvfb \
    && rm -rf /var/lib/apt/lists/*

RUN curl --retry 5 --retry-all-errors --connect-timeout 20 -fsSL \
      "https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/mediamtx_v${MEDIAMTX_VERSION}_linux_amd64.tar.gz" \
      | tar -xz -C /usr/local/bin mediamtx \
    && curl --retry 5 --retry-all-errors --connect-timeout 20 -fsSL \
      "https://github.com/AlexxIT/go2rtc/releases/download/v${GO2RTC_VERSION}/go2rtc_linux_amd64" \
      -o /usr/local/bin/go2rtc \
    && chmod +x /usr/local/bin/mediamtx /usr/local/bin/go2rtc

RUN curl --retry 5 --retry-all-errors --connect-timeout 20 -fsSL \
      https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
      -o /tmp/google-chrome-stable_current_amd64.deb \
    && apt-get update \
    && apt-get install -y --no-install-recommends /tmp/google-chrome-stable_current_amd64.deb \
    && rm -f /tmp/google-chrome-stable_current_amd64.deb \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY healthcheck.sh /usr/local/bin/healthcheck.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/healthcheck.sh

EXPOSE 80/tcp 554/tcp 8555/tcp 8555/udp 3702/udp
VOLUME ["/config"]

HEALTHCHECK --interval=20s --timeout=10s --start-period=30s --retries=3 \
  CMD ["/usr/local/bin/healthcheck.sh"]

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["/usr/local/bin/entrypoint.sh"]
